export type Listener = { url(): string | null; close(): Promise<void> };
export type ForwardOptions = {
  addr: string;
  authtoken: string;
  domain?: string;
  force_new_session: boolean;
  onStatusChange: (status: string) => void;
};
export type TunnelDriver = {
  forward(options: ForwardOptions): Promise<Listener>;
  /** Close this driver's session, including a connection that is still opening. */
  close?(): Promise<void>;
};

// Keep the native SDK behind a small injectable contract. A listener's close
// RPC cannot stop an offline transport; session ownership provides that stop.
export interface NativeTunnelListener {
  url(): string | null;
  join(): Promise<void>;
  close(): Promise<void>;
}
export interface TunnelSession {
  httpEndpoint(): {
    scheme(value: string): ReturnType<TunnelSession['httpEndpoint']>;
    domain(value: string): ReturnType<TunnelSession['httpEndpoint']>;
    listenAndForward(addr: string): Promise<NativeTunnelListener>;
  };
  close(): Promise<void>;
}
export interface TunnelSessionBuilder {
  authtoken(value: string): TunnelSessionBuilder;
  handleDisconnection(handler: (addr: string, error: string) => boolean): TunnelSessionBuilder;
  handleHeartbeat(handler: (latency: number) => void): TunnelSessionBuilder;
  connect(): Promise<TunnelSession>;
}

/** One driver belongs to one start attempt and never touches another session. */
export function createTunnelDriver(createBuilder: () => TunnelSessionBuilder): TunnelDriver {
  let started = false;
  let closing = false;
  let closed = false;
  let interrupted = false;
  let session: TunnelSession | undefined;
  let connecting: Promise<TunnelSession> | undefined;
  let listening: Promise<NativeTunnelListener> | undefined;
  let listener: NativeTunnelListener | undefined;
  let joining: Promise<void> | undefined;
  let sessionCloseAttempt: Promise<void> | undefined;
  let sessionCloseFailure: unknown;
  let closeAttempt: Promise<void> | undefined;

  function closeSession(owned: TunnelSession): Promise<void> {
    if (sessionCloseAttempt) return sessionCloseAttempt;
    sessionCloseAttempt = Promise.resolve().then(() => owned.close())
      .then(() => { sessionCloseFailure = undefined; }, error => { sessionCloseFailure = error; throw error; })
      .finally(() => { sessionCloseAttempt = undefined; });
    return sessionCloseAttempt;
  }

  function close(): Promise<void> {
    closing = true;
    if (closed) return Promise.resolve();
    if (closeAttempt) return closeAttempt;
    closeAttempt = Promise.resolve().then(async () => {
      let owned = session;
      if (!owned && connecting) {
        try { owned = await connecting; }
        catch { closed = true; return; } // No native session was created.
      }
      // Session.close terminates the owned transport and its reconnect loop.
      // Listener.close is only an RPC and can reject while disconnected.
      let closeFailure: unknown;
      if (owned) {
        try { await closeSession(owned); }
        catch (error) {
          // The native close still marks the session closed when its already
          // disconnected transport cannot send GOAWAY. Confirm task exit too.
          if (!(error instanceof Error) || error.message !== 'failed to close session: transport error') throw error;
          closeFailure = error;
        }
      }
      // A listener can arrive after stop was requested. Keep ownership until
      // endpoint creation settles, then wait for the forwarding task to exit.
      if (!listener && listening) {
        try { listener = await listening; } catch { /* No listener was created. */ }
      }
      if (listener) {
        await joining;
      } else if (closeFailure) throw closeFailure;
      // A heartbeat can start a second close while join is pending. Do not
      // release ownership until that attempt also finishes.
      if (sessionCloseAttempt) {
        try { await sessionCloseAttempt; }
        catch (error) {
          if (!listener || !(error instanceof Error) || error.message !== 'failed to close session: transport error') throw error;
        }
      }
      if (sessionCloseFailure && (!(sessionCloseFailure instanceof Error) || sessionCloseFailure.message !== 'failed to close session: transport error')) throw sessionCloseFailure;
      closed = true;
      interrupted = false;
      // After the forwarding task ended, release the SDK's global reference.
      // This offline RPC can reject; it never determines whether stop succeeded.
      if (listener) void listener.close().catch(() => {});
    }).finally(() => { closeAttempt = undefined; });
    // A rejected close retains the session and allows another explicit retry.
    return closeAttempt;
  }

  return {
    close,
    async forward(options) {
      if (started || closing) throw new Error('This public connection driver has already been used.');
      started = true;
      const notify = (status: string) => {
        if (closed || closing) return;
        // Observer failures must not escape into the SDK's heartbeat/retry loop.
        try { options.onStatusChange(status); } catch { /* State observation cannot own transport lifetime. */ }
      };
      try {
        const builder = createBuilder()
          .authtoken(options.authtoken)
          .handleDisconnection(() => {
            if (!closed && !closing) {
              interrupted = true;
              notify('closed');
            }
            // Native ConnectError::Canceled stops retries during shutdown.
            return !closing && !closed;
          })
          .handleHeartbeat(latency => {
            if (typeof latency !== 'number' || !Number.isFinite(latency) || latency < 0 || closed) return;
            if (closing) {
              // A reconnect may already have been in flight when close began.
              // Re-close its current transport while join confirms final exit.
              if (session) void closeSession(session).catch(() => {});
            } else if (interrupted) {
              interrupted = false;
              notify('connected');
            }
          });
        // Explicit builders always create a new session, regardless of a caller's
        // legacy force_new_session flag. There is no shared high-level session.
        connecting = Promise.resolve().then(() => builder.connect());
        session = await connecting;
        if (closing) {
          await close();
          throw new Error('Public connection opening was cancelled.');
        }
        let endpoint = session.httpEndpoint().scheme('HTTPS');
        if (options.domain) endpoint = endpoint.domain(options.domain);
        listening = Promise.resolve().then(() => endpoint.listenAndForward(options.addr));
        listener = await listening;
        // The native join handle must only be awaited once. A native task error
        // also proves task exit; registry lookup failures do not.
        joining = listener.join().catch(error => {
          if (!(error instanceof Error) || !error.message.startsWith('error on join:')) throw error;
        });
        void joining.catch(() => {});
        if (closing) {
          await close();
          throw new Error('Public connection opening was cancelled.');
        }
        return { url: () => closed ? null : listener!.url(), close };
      } catch (cause) {
        // Preserve the original setup error. The driver's close method remains
        // available to its owner if cleanup itself rejects or stays pending.
        await close().catch(() => {});
        throw cause;
      }
    },
  };
}

export async function loadTunnelDriver(): Promise<TunnelDriver> {
  const { SessionBuilder } = await import('@ngrok/ngrok');
  return createTunnelDriver(() => new SessionBuilder());
}
