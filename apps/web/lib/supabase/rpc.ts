/**
 * Result guards for Supabase RPC calls.
 *
 * PostgREST answers a `returns void` function with `data: null, error: null`. That is a success,
 * not an empty result, and treating it as failure is invisible in types and silent in tests: the
 * database commits, the caller throws, and the product reports an error for work that actually
 * happened. Agent Test runs were persisted `status=completed, failure_code=null` while the browser
 * showed a failure for exactly this reason.
 *
 * The fix is not to stop checking for null. A function that is contractually required to return
 * rows and returns none is still a failure, and weakening that would trade a visible bug for a
 * quiet one. So the two contracts get two guards, and the types keep them apart: `requireVoidRpc`
 * accepts only a response whose `data` is `null`, which means a data-returning call cannot be
 * passed to it — `T[] | null` is not assignable to `null`, so the compiler rejects the mistake
 * rather than a reviewer having to catch it.
 *
 * Both guards fail closed on a non-null `error`, always.
 */

export interface RpcError {
  readonly message: string;
}

/** A call whose contract is to return data. Null data means the contract was not met. */
export type RpcResponse<Data> = { data: Data | null; error: RpcError | null };

/** A call to a `returns void` function. Success is `data: null, error: null`. */
export type VoidRpcResponse = { data: null; error: RpcError | null };

export interface RpcGuards {
  /**
   * Requires a data-returning RPC to have produced data. Passing a void RPC here infers `never`
   * and is unusable at the call site, which is the intended signal.
   *
   * Declared as a property rather than a method so it stays safe to destructure: neither guard
   * touches `this`, and every caller pulls them off the returned object.
   */
  readonly requireRpcData: <Data>(request: PromiseLike<RpcResponse<Data>>) => Promise<Data>;
  /** Requires only that a `returns void` RPC did not error. Null data is the success shape. */
  readonly requireVoidRpc: (request: PromiseLike<VoidRpcResponse>) => Promise<void>;
}

/**
 * Binds both guards to one service's error type, so a caller cannot accidentally surface another
 * area's failure message. The factory is deliberately not generic over the error: it is thrown, not
 * returned, and every caller in a service wants the same one.
 */
export function createRpcGuards(createError: () => Error): RpcGuards {
  return {
    requireRpcData: async <Data>(request: PromiseLike<RpcResponse<Data>>): Promise<Data> => {
      const { data, error } = await request;
      if (error || data === null) throw createError();
      return data;
    },
    requireVoidRpc: async (request: PromiseLike<VoidRpcResponse>): Promise<void> => {
      const { error } = await request;
      if (error) throw createError();
    },
  };
}
