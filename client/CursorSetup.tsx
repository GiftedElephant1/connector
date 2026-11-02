import { useId, useState } from "react";
import "./cursor-setup.css";

function connectorUrl(value: string, publicReady: boolean): string | null {
  if (!publicReady) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.endsWith("/mcp") ||
      url.hostname === "localhost" ||
      url.hostname.endsWith(".localhost") ||
      url.hostname === "[::1]" ||
      /^127\./.test(url.hostname)
    ) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function CursorSetup({ url, publicReady }: {
  url: string;
  publicReady: boolean;
}) {
  const id = useId();
  const [copiedConfiguration, setCopiedConfiguration] = useState("");
  const [failedConfiguration, setFailedConfiguration] = useState("");
  const endpoint = connectorUrl(url, publicReady);
  const configuration = endpoint
    ? JSON.stringify({ mcpServers: { connector: { url: endpoint } } }, null, 2)
    : "";
  // URL serialization percent-encodes non-ASCII characters, so the inner
  // configuration is safe to encode with the browser's base64 function.
  const installUrl = endpoint
    ? `cursor://anysphere.cursor-deeplink/mcp/install?name=connector&config=${encodeURIComponent(btoa(JSON.stringify({ url: endpoint })))}`
    : undefined;
  const copied = Boolean(configuration && copiedConfiguration === configuration);
  const copyFailed = Boolean(configuration && failedConfiguration === configuration);

  async function copyConfiguration() {
    if (!configuration) return;
    setCopiedConfiguration("");
    setFailedConfiguration("");
    try {
      await navigator.clipboard.writeText(configuration);
      setCopiedConfiguration(configuration);
    } catch {
      setFailedConfiguration(configuration);
    }
  }

  return <section className="cursor-setup" aria-label="Cursor connection setup">
    <p>
      Add Connector to the Cursor desktop app. Review the server in Cursor,
      then authenticate and approve access in Connector. Adding the server
      does not grant access by itself.
    </p>
    <div className="cursor-setup-actions">
      {installUrl ? (
        <a className="button button-primary" href={installUrl}>Add to Cursor</a>
      ) : (
        <button className="button button-primary" disabled>Add to Cursor</button>
      )}
      <button
        className="button button-secondary"
        disabled={!endpoint}
        onClick={() => void copyConfiguration()}
      >
        Copy Cursor configuration
      </button>
    </div>
    {!endpoint && <p className="setup-help">
      Turn on public HTTPS access above before adding Connector to Cursor.
      The Connector URL must end in /mcp and contain no password, query, or fragment.
    </p>}
    {copied && <p role="status">Cursor configuration copied. Merge it into your existing MCP configuration.</p>}
    {copyFailed && <p role="status">Copying was unavailable. Select and copy the configuration below.</p>}
    {endpoint && <details open={copyFailed || undefined}>
      <summary>View Cursor configuration</summary>
      <p>
        If the button does not open Cursor, use Cursor’s MCP settings to open
        your global configuration file. On Windows, this is{" "}
        <code>%USERPROFILE%\.cursor\mcp.json</code>; on other systems,
        use <code>~/.cursor/mcp.json</code>.
      </p>
      <p>
        If you already have a configuration, merge the <code>connector</code>{" "}
        entry into its existing <code>mcpServers</code> object. Keep all other
        server entries and settings. Review an existing <code>connector</code>{" "}
        entry before replacing it. If the file is new, use the complete
        configuration below.
      </p>
      <label htmlFor={`${id}-configuration`}>Cursor MCP configuration</label>
      <textarea
        id={`${id}-configuration`}
        readOnly
        rows={9}
        value={configuration}
        onFocus={(event) => event.currentTarget.select()}
      />
      <p className="setup-help">
        Save the file, then return to Cursor’s MCP settings to authenticate
        Connector. Keep Connector running with public access on while using its tools.
      </p>
    </details>}
    <p className="setup-help">
      <a href="https://cursor.com/docs/mcp" target="_blank" rel="noopener noreferrer">Cursor setup guide</a>
      {" · "}
      <a href="https://cursor.com/docs/mcp/install-links" target="_blank" rel="noopener noreferrer">About Cursor install links</a>
    </p>
  </section>;
}
