import type { EventSource } from 'eventsource'
import Redis from 'ioredis'
import { Cache } from '../cache'
import { AdapterConfig, BaseAdapterSettings, SettingsDefinitionMap } from '../config'
import { AdapterRateLimitTier, RateLimiter } from '../rate-limiting'
import { Transport, TransportGenerics, TransportRoutes } from '../transports'
import { AdapterRequest, AdapterResponse, LoggerFactory, SubscriptionSetFactory } from '../util'
import { Requester } from '../util/requester'
import { InputParameters } from '../validation'
import { AdapterError } from '../validation/error'
import { TypeFromDefinition } from '../validation/input-params'
import { Adapter } from './basic'
import { AdapterEndpoint } from './endpoint'

export type CustomAdapterSettings = SettingsDefinitionMap & NegatedAdapterSettings
type NegatedAdapterSettings = {
  [K in keyof BaseAdapterSettings]?: never
}

/**
 * Dependencies that will be injected into the Adapter on startup
 */
export interface AdapterDependencies {
  /** Specific instance of the Cache the adapter will use (e.g. Local, Redis, etc.) */
  cache: Cache

  /** Shared instance of the request rate limiter */
  rateLimiter: RateLimiter

  /** Factory to create subscription sets based on the specified cache type */
  subscriptionSetFactory: SubscriptionSetFactory

  /** Redis client used for cache and subscription set */
  redisClient: Redis

  /** EventSource to use for listening to server sent events.  A mock EventSource can be provided as a dependency for testing */
  eventSource: typeof EventSource

  /** Shared instance to handle sending http requests in a centralized fashion */
  requester: Requester

  /** Factory that will provide logger instances for the adapter. */
  loggerFactory: LoggerFactory
}

/**
 * Context that will be used on background executions of a Transport.
 * For example, the endpointName used to log statements or generate Cache keys.
 */
export interface EndpointContext<T extends EndpointGenerics> {
  /** Endpoint name */
  endpointName: string

  /** Input parameters for this endpoint */
  inputParameters: InputParameters<T['Parameters']>

  /** Initialized config for the adapter that the Transport can access */
  adapterSettings: T['Settings']
}

/**
 * Structure to describe rate limits specs for the Adapter
 */
export interface AdapterRateLimitingConfig {
  /** Adapter rate limits, gotten from the specific tier requested */
  tiers: Record<string, AdapterRateLimitTier>
}

/**
 * Type to perform arbitrary modifications on an adapter request
 */
export type RequestTransform<T extends EndpointGenerics> = (
  req: AdapterRequest<TypeFromDefinition<T['Parameters']>>,
  settings: T['Settings'],
) => void

/**
 * Main structure of an External Adapter
 */
export interface AdapterParams<CustomSettingsDefinition extends SettingsDefinitionMap> {
  /** Name of the adapter */
  name: Uppercase<string>

  /** If present, the string that will be used for requests with no specified endpoint */
  defaultEndpoint?: string

  /**
   * List of [[AdapterEndpoint]]s in the adapter. This is purposefully typed any; it's the correct type in this case.
   *
   * When you try to create an adapter and you provide an endpoint, if these generics were set to "unknown" instead
   * what would happen is that Typescript would check if the types match, and would fail to assign unknown to the
   * specific Params or Result in the transport itself.
   * We also can't use generics, because if we had more than one transport with different requests (very likely)
   * then those new types wouldn't match with each other.
   */
  endpoints: AdapterEndpoint<any>[] // eslint-disable-line @typescript-eslint/no-explicit-any

  /** Configuration relevant to outbound (EA --\> DP) communication rate limiting */
  rateLimiting?: AdapterRateLimitingConfig

  /** Bootstrap function that will run when initializing the adapter */
  bootstrap?: (adapter: Adapter<CustomSettingsDefinition>) => Promise<void>

  /** The custom [[AdapterConfig]] to use. If not provided, the default configuration will be used instead */
  config?: AdapterConfig<CustomSettingsDefinition>
}

/**
 * Structure to describe rate limits specs for a specific adapter endpoint
 */
export interface EndpointRateLimitingConfig {
  /**
   * How much of the total limit for the adapter will be assigned to this specific endpoint.
   * Should be a non-zero positive number up to 100.
   * Endpoints in the same adapter without a specific allocation will divide the remaining limits equally.
   */
  allocationPercentage: number
}

/**
 * Helper type structure that contains the different types passed to the generic parameters of an AdapterEndpoint
 */
export type EndpointGenerics = TransportGenerics

export type CustomInputValidator<T extends EndpointGenerics> = (
  input: AdapterRequest<TypeFromDefinition<T['Parameters']>>,
  adapterSettings: T['Settings'],
) => AdapterError | undefined

export type CustomOutputValidator = (output: Readonly<AdapterResponse>) => AdapterError | undefined

/**
 * Structure to describe a specific endpoint in an [[Adapter]]
 */
export interface BaseAdapterEndpointParams<T extends EndpointGenerics> {
  /** Name that will be used to match input params to this endpoint (case insensitive) */
  name: string

  /** List of alternative endpoint names that will resolve to this same transport (case insensitive) */
  aliases?: string[]

  /** Specification of what the body of a request hitting this endpoint should look like (used for validation) */
  inputParameters?: InputParameters<T['Parameters']>

  /** Specific details related to the rate limiting for this endpoint in particular */
  rateLimiting?: EndpointRateLimitingConfig

  /** Custom function that generates cache keys */
  cacheKeyGenerator?: (data: TypeFromDefinition<T['Parameters']>) => string

  /**
   * Custom input validation. Void function that should throw AdapterInputError on validation errors.
   * Can be used to pre-transform requests before all the requestTransforms happens
   */
  customInputValidation?: CustomInputValidator<T>

  /** Custom output validation. Void function that should throw AdapterError on validation errors */
  customOutputValidation?: CustomOutputValidator

  /** Transforms that will apply to the request before submitting it through the adapter request flow */
  requestTransforms?: RequestTransform<T>[]

  /** Overrides for converting the 'base' parameter that are hardcoded into the adapter. */
  // This must be included in the middleware in order to generate deterministing cache keys for hardcoded overrides
  overrides?: Record<string, string>
}

type SingleTransportAdapterEndpointParams<T extends EndpointGenerics> = {
  /** Transport that will be used to handle data processing and communication for this endpoint */
  transport: Transport<T>
}

type MultiTransportAdapterEndpointParams<T extends EndpointGenerics> = {
  /** Map of transports that will be used when routing the request through this endpoint */
  transportRoutes: TransportRoutes<T>

  /** Custom function to direct an incoming request to the appropriate transport from the transports map */
  customRouter?: (
    req: AdapterRequest<TypeFromDefinition<T['Parameters']>>,
    settings: T['Settings'],
  ) => string

  /** If no value is returned from the custom router or the default (transport param), which transport to use */
  defaultTransport?: string
}

/**
 * Basic interface for the properties that the adapter endpoint will have, taken from the endpoint parameters.
 * The reason why this is its own type is because the endpoint can be defined with one transport or multiple.
 */
export interface AdapterEndpointInterface<T extends EndpointGenerics>
  extends BaseAdapterEndpointParams<T>,
    MultiTransportAdapterEndpointParams<T> {}

/**
 * Type for the parameters that an adapter endpoint requires. See the comment in the [[AdapterEndpointInterface]] for more details.
 */
export type AdapterEndpointParams<T extends EndpointGenerics> = BaseAdapterEndpointParams<T> &
  (SingleTransportAdapterEndpointParams<T> | MultiTransportAdapterEndpointParams<T>)
