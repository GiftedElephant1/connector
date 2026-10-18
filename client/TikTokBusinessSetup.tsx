import { CopyValue } from "./Setup";

export function TikTokBusinessSetup({ callbackUrl }: { callbackUrl: string }) {
  let runtime: URL | undefined;
  try { runtime = new URL(callbackUrl); } catch { /* Wait for a valid workspace address before offering callbacks. */ }
  const publicReady = runtime?.protocol === "https:" && !runtime.port && !["localhost", "127.0.0.1", "[::1]"].includes(runtime.hostname);

  return <section aria-label="TikTok for Business setup guide">
    <strong>Register both TikTok for Business redirect URLs</strong>
    <p>In your TikTok for Business developer application, paste each address into its matching field and save.</p>
    {publicReady && runtime ? <>
      <CopyValue label="Advertiser redirect URL" value={new URL("/api/oauth/tiktok-business/callback", runtime.origin).href} />
      <CopyValue label="TikTok account holder redirect URL" value={new URL("/api/oauth/tiktok-business-account/callback/", runtime.origin).href} />
    </> : <p className="setup-notice">Start public access in Settings, then reopen this setup to copy your HTTPS redirect URLs.</p>}
    <p>Keep the complete paths, including the final slash on the account holder URL. TikTok account holder redirects require HTTPS without a custom port. These addresses must point to your running Connector workspace. Update both entries if its public address changes.</p>
    <p>Use the same TikTok for Business App ID and secret for these Business authorization flows. For TikTok account holder authorization, also copy the authorization URL generated in the app’s TikTok account holder authorization section into Connector setup.</p>
    <p className="setup-help">These Business callbacks are separate from TikTok for Developers Login Kit. The regular TikTok connection uses <code>/api/oauth/tiktok/callback</code> and its own application credentials.</p>
  </section>;
}
