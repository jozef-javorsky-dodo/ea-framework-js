import { InstalledClock } from '@sinonjs/fake-timers'
import { ExecutionContext } from 'ava'
import { FastifyInstance } from 'fastify'
import { ReplyError } from 'ioredis'
import { WebSocket } from 'mock-socket'
import * as client from 'prom-client'
import { Adapter, AdapterDependencies } from '../adapter'
import { Cache, LocalCache } from '../cache'
import { ResponseCache } from '../cache/response'
import { EmptyCustomSettings, SettingsDefinitionMap } from '../config'
import { start } from '../index'
import {
  Transport,
  TransportDependencies,
  TransportGenerics,
  WebSocketClassProvider,
} from '../transports'
import { EmptyInputParameters, TypeFromDefinition } from '../validation/input-params'
import { AdapterRequest, AdapterResponse, PartialAdapterResponse, sleep } from './index'
export { WebSocket as MockWebsocket, Server as MockWebsocketServer } from 'mock-socket'

export type NopTransportTypes = {
  Parameters: EmptyInputParameters
  Response: {
    Data: null
    Result: null
  }
  Settings: EmptyCustomSettings
}

/* c8 ignore start */ // eslint-disable-line
export class NopTransport<T extends TransportGenerics = NopTransportTypes> implements Transport<T> {
  name!: string
  responseCache!: ResponseCache<T>

  async initialize(
    dependencies: TransportDependencies<T>,
    adapterSettings: T['Settings'],
    endpointName: string,
    transportName: string,
  ): Promise<void> {
    this.responseCache = dependencies.responseCache
    this.name = transportName
    return
  }

  async foregroundExecute(
    _: AdapterRequest<TypeFromDefinition<T['Parameters']>>,
  ): Promise<void | AdapterResponse<T['Response']>> {
    return
  }
}

export class MockCache extends LocalCache {
  constructor(maxItems: number) {
    super(maxItems)
  }
  private awaitingPromiseResolve?: (value: unknown) => void

  waitForNextSet() {
    // eslint-disable-next-line no-promise-executor-return
    return new Promise((resolve) => (this.awaitingPromiseResolve = resolve))
  }

  override async set(key: string, value: Readonly<unknown>, ttl: number): Promise<void> {
    super.set(key, value, ttl)
    if (this.awaitingPromiseResolve) {
      this.awaitingPromiseResolve(value)
    }
  }
}

export async function runPeriodicAsyncBackgroundExecution(
  clock: InstalledClock,
  {
    interval,
    times,
    stepValidation,
  }: {
    interval: number
    times: number
    stepValidation: (iteration: number) => boolean
  },
) {
  for (let i = 0; i < times; i++) {
    // Tick once for the interval
    await clock.tickAsync(interval)

    // Then use auxiliary method to ensure that the background process, if it
    // spawns new timers, gets executed to completion
    await runAllUntil(clock, () => stepValidation(i))
  }
}

export async function runAllUntil(clock: InstalledClock, isComplete: () => boolean): Promise<void> {
  while (!isComplete()) {
    await clock.nextAsync()
  }
}

export async function runAllUntilTime(clock: InstalledClock, time: number): Promise<void> {
  const targetTime = clock.now + time
  // Fire a promise that will resolve at the requested time, so we have a precise place where we'll stop
  sleep(time)
  while (clock.now < targetTime) {
    await clock.nextAsync()
  }
}

export class RedisMock {
  store = new LocalCache<string>(10000)
  keys: { [key: string]: string } = {}

  get(key: string) {
    return this.store.get(key)
  }

  del(key: string) {
    return this.store.delete(key)
  }

  set(key: string, value: string, px: 'PX', ttl: number) {
    if (key.includes('force-error')) {
      throw { message: 'anything' } as typeof ReplyError
    }
    return this.store.set(key, value, ttl)
  }

  multi() {
    return new CommandChainMock(this)
  }

  defineCommand(
    _name: 'setExternalAdapterResponse',
    _options: { lua: string; numberOfKeys: number },
  ) {
    return
  }

  setExternalAdapterResponse(key: string, value: string, ttl: number) {
    return this.set(key, value, 'PX', ttl)
  }

  evalsha(...args: [string, number, [string, string, number]]) {
    const [redlockKey, instanceKey] = args[2]

    // If key has been used to acquire a lock, and the instance key matches, extend it
    if (this.keys[redlockKey] === instanceKey) {
      return 1
    }

    // If key has not been used to acquire a lock, set it
    if (this.keys[redlockKey] === undefined) {
      this.keys[redlockKey] = instanceKey
      return 1
    } else {
      // If key has already been used, reject lock acquisition
      return 0
    }
  }

  pexpire() {
    return
  }

  // For cache lock tests - naive implementation as the necessary error will
  // already have been thrown and the test will end the process
  quit() {
    return
  }
}

class CommandChainMock {
  promises: Promise<unknown>[] = []

  constructor(private redisMock: RedisMock) {}

  set(key: string, value: string, px: 'PX', ttl: number) {
    this.promises.push(this.redisMock.set(key, value, px, ttl))
    return this
  }

  setExternalAdapterResponse(key: string, value: string, ttl: number) {
    this.promises.push(this.redisMock.setExternalAdapterResponse(key, value, ttl))
    return this
  }

  exec() {
    return Promise.all(this.promises)
  }
}

export function assertEqualResponses(
  t: ExecutionContext,
  actual: AdapterResponse,
  expected: PartialAdapterResponse & {
    statusCode: number
  },
) {
  t.is(typeof actual?.timestamps?.providerDataReceivedUnixMs, 'number')
  t.is(
    typeof (
      actual?.timestamps?.providerDataReceivedUnixMs ??
      actual?.timestamps?.providerDataStreamEstablishedUnixMs
    ),
    'number',
  )

  delete actual?.meta

  delete (actual as unknown as Record<string, unknown>)['timestamps']

  t.deepEqual(expected, actual)
}

class TestMetrics {
  map = new Map<string, number>()

  private replaceQuotes(s: string) {
    return s.replace(/\\"/g, "'")
  }

  constructor(data: string) {
    const lines = data.split('\n')
    for (const line of lines) {
      if (
        line.startsWith('#') ||
        line.startsWith('nodejs_') ||
        line.startsWith('process_') ||
        !line
      ) {
        continue
      }

      const [nameAndLabels, stringValue] = line.split(' ')
      const [, name, rawLabels] = nameAndLabels.match(/^([a-z_]+){(.*)}$/) as string[]
      const sortedLabels = this.replaceQuotes(rawLabels)
        .split('",')
        .filter((label) => label !== '' && !label.startsWith('app_'))
        .sort((a, b) => a.localeCompare(b))
        .map((s) => `${s}"`)
        .join(',')
      const fullName = `${name}|${sortedLabels}`

      this.map.set(fullName, Number(stringValue))
    }
  }

  private get(
    t: ExecutionContext,
    { name, labels }: { name: string; labels?: Record<string, string> },
  ): number | undefined {
    const sortedLabels = labels
      ? Object.entries(labels)
          .map(([labelName, value]) => `${labelName}="${this.replaceQuotes(value)}"`)
          .sort((a, b) => a.localeCompare(b))
          .join(',')
      : ''

    const metric = this.map.get(`${name}|${sortedLabels}`)
    if (metric === undefined) {
      const sameNameMetrics = [...this.map.keys()]
        .filter((k) => k.startsWith(name))
        .map((m) => `\n\t${m}`)
      const possibleSolutionMessage = sameNameMetrics.length
        ? `Perhaps you meant one of these: ${sameNameMetrics}`
        : 'Check the metric name and labels (no other metrics with the same name were found)'

      t.fail(`Metric not found:\n\t${name}|${sortedLabels}\n${possibleSolutionMessage}`)
    }

    return metric
  }

  assert(
    t: ExecutionContext,
    params: {
      name: string
      labels?: Record<string, string>
      expectedValue: number
    },
  ) {
    const metric = this.get(t, params)
    t.is(metric, params.expectedValue)
  }

  assertPositiveNumber(
    t: ExecutionContext,
    params: {
      name: string
      labels?: Record<string, string>
    },
  ) {
    const value = this.get(t, params)
    if (value !== undefined) {
      t.is(typeof value === 'number', true)
      t.is(value > 0, true)
    } else {
      t.fail(`${params.name} did not record`)
    }
  }
}

export class TestAdapter<T extends SettingsDefinitionMap = SettingsDefinitionMap> {
  mockCache?: MockCache

  // eslint-disable-next-line max-params
  constructor(
    public api: FastifyInstance,
    public adapter: Adapter<T>,
    public metricsApi?: FastifyInstance,
    public clock?: InstalledClock,
    cache?: Cache,
  ) {
    if (cache instanceof MockCache) {
      this.mockCache = cache
    }
  }

  static async startWithMockedCache<T extends SettingsDefinitionMap = SettingsDefinitionMap>(
    adapter: Adapter<T>,
    context: ExecutionContext<{
      clock?: InstalledClock
      testAdapter: TestAdapter<T>
    }>['context'],
    dependencies?: Partial<AdapterDependencies>,
  ) {
    // Create mocked cache so we can listen when values are set
    // This is a more reliable method than expecting precise clock timings
    const mockCache = new MockCache(adapter.config.settings.CACHE_MAX_ITEMS)

    return TestAdapter.start(adapter, context, {
      cache: mockCache,
      ...dependencies,
    }) as Promise<
      TestAdapter<T> & {
        mockCache: MockCache
      }
    >
  }

  static async start<T extends SettingsDefinitionMap = SettingsDefinitionMap>(
    adapter: Adapter<T>,
    context: ExecutionContext<{
      clock?: InstalledClock
      testAdapter: TestAdapter<T>
    }>['context'],
    dependencies?: Partial<AdapterDependencies>,
  ) {
    const { api, metricsApi } = await start(adapter, dependencies)
    if (!api) {
      throw new Error('EA was not able to start properly')
    }
    context.testAdapter = new TestAdapter(
      api,
      adapter,
      metricsApi,
      context.clock,
      dependencies?.cache,
    )
    return context.testAdapter
  }

  async request(data?: object, headers?: Record<string, string>) {
    const makeRequest = async () =>
      this.api.inject({
        method: 'post',
        url: '/',
        headers: {
          'content-type': 'application/json',
          ...headers,
        },
        payload: {
          data,
        },
      })

    // If there's no installed clock, just return the normal response promise
    if (!this.clock) {
      return makeRequest()
    }

    return waitUntilResolved(this.clock, makeRequest)
  }

  async startBackgroundExecuteThenGetResponse(
    t: ExecutionContext,
    params: {
      requestData: object
      expectedResponse?: PartialAdapterResponse & {
        statusCode: number
      }
      expectedCacheSize?: number
    },
  ) {
    if (!this.clock) {
      throw new Error(
        'The "startBackgroundExecuteThenGetResponse" method should only be called if a fake clock is installed',
      )
    }

    if (!this.mockCache) {
      throw new Error(
        'The "startBackgroundExecuteThenGetResponse" method should only be called if a mock cache was provided',
      )
    }

    // Expect the first response to time out
    // The polling behavior is tested in the cache tests, so this is easier here.
    // Start the request:
    const error = await this.request(params.requestData)
    t.is(error.statusCode, 504)

    await this.waitForCache(params.expectedCacheSize)

    // Second request should find the response in the cache
    const response = await this.request(params.requestData)

    if (params.expectedResponse) {
      assertEqualResponses(t, response.json(), params.expectedResponse)
    } else {
      t.is(response.statusCode, 200)
    }

    return response
  }

  async waitForCache(expectedSize?: number) {
    if (!this.clock) {
      throw new Error(
        'The "startBackgroundExecuteThenGetResponse" method should only be called if a fake clock is installed',
      )
    }

    // Advance clock so that the batch warmer executes once again and wait for the cache to be set
    // We disable the non-null assertion because we've already checked for existence in the line above
    await runAllUntil(this.clock, () => {
      const cacheSize = this.mockCache!.cache.size
      return cacheSize >= (expectedSize || 1)
    })
  }

  async getMetrics(): Promise<TestMetrics> {
    if (!this.metricsApi) {
      throw new Error(
        'An attempt was made to fetch metrics, but the adapter was started without metrics enabled',
      )
    }
    const response = await client.register.metrics()
    return new TestMetrics(response)
  }

  async getHealth() {
    return this.api.inject('/health')
  }
}

// This is the janky workaround to synchronously running async flows with fixed timers that block threads
export async function waitUntilResolved<T>(
  clock: InstalledClock,
  fn: () => Promise<T>,
): Promise<T> {
  let result
  const execute = async () => {
    result = await fn()
  }
  execute()
  // eslint-disable-next-line no-unmodified-loop-condition
  while (result === undefined) {
    await clock.nextAsync()
  }

  return result
}

export function setEnvVariables(envVariables: NodeJS.ProcessEnv): void {
  for (const key in envVariables) {
    process.env[key] = envVariables[key]
  }
}

/**
 * Sets the mocked websocket instance in the provided provider class.
 * We need this here, because the tests will connect using their instance of WebSocketClassProvider;
 * fetching from this library to the \@chainlink/ea-bootstrap package would access _another_ instance
 * of the same constructor. Although it should be a singleton, dependencies are different so that
 * means that the static classes themselves are also different.
 *
 * @param provider - singleton WebSocketClassProvider
 */
export const mockWebSocketProvider = (provider: typeof WebSocketClassProvider): void => {
  // Extend mock WebSocket class to bypass protocol headers error
  class MockWebSocket extends WebSocket {
    constructor(url: string, protocol: string | string[] | Record<string, string> | undefined) {
      super(url, protocol instanceof Object ? undefined : protocol)
    }
    // This is part of the 'ws' node library but not the common interface, but it's used in our WS transport
    removeAllListeners() {
      for (const eventType in this.listeners) {
        // We have to manually check because the mock-socket library shares this instance, and adds the server listeners to the same obj
        if (!eventType.startsWith('server')) {
          delete this.listeners[eventType]
        }
      }
    }
  }

  // Need to disable typing, the mock-socket impl does not implement the ws interface fully
  provider.set(MockWebSocket as any) // eslint-disable-line @typescript-eslint/no-explicit-any
}

// Wraps an object such that accessing properties that do not exist will throw
// an error instead of returning undefined.
//
// This is useful during unit test creation, as it makes it clear which
// properties are missing rather than giving an error later on that undefined
// doesn't have some other property.
//
// Once a test is passing, you can remove the wrapping and the test will still
// pass. But it might be useful to keep it for when the code under test is
// changed later on.
//
// Example usage:
//
// In code under test:
//
//   function doThing(obj) {
//     const baz = obj.foo.baz
//     ...
//   }
//
// In test code:
//
//   const obj = makeStub('obj', { foo: { bar: 1 } })
//   doThing(obj)
//
// Throws (and logs, in case the error is caught by the code under test):
// Error: Property 'obj.foo.baz' does not exist
export function makeStub<T>(name: string, obj: T): T {
  if (obj === null || typeof obj !== 'object') {
    return obj
  }
  return new Proxy(obj, {
    get: (target, prop) => {
      const propName = `${name}.${String(prop)}`
      if (!(prop in target) && !isStubPropAllowedUndefined(prop)) {
        const message = `Property '${propName}' does not exist`
        // eslint-disable-next-line no-console
        console.error(message)
        throw new Error(message)
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return makeStub(propName, (target as any)[prop])
    },
  }) as T
}

// Properties checked by jest which don't need to be defined:
export const allowedUndefinedStubProps = [
  '$$typeof',
  'nodeType',
  'tagName',
  'hasAttribute',
  '@@__IMMUTABLE_ITERABLE__@@',
  '@@__IMMUTABLE_RECORD__@@',
  'toJSON',
  'asymmetricMatch',
  'then',
]

const isStubPropAllowedUndefined = (prop: string | symbol) => {
  if (typeof prop === 'symbol') {
    return true
  }
  return allowedUndefinedStubProps.includes(prop as string)
}

/* c8 ignore stop */ // eslint-disable-line
