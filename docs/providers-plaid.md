# Plaid bank data

Plaid connects one financial institution at a time through the official Plaid Link interface. It reads authorized account names, masked account identifiers, current balances, and transaction history. This connector does not request Auth, transfer, payment initiation, or account-number products and cannot move money. Bank login credentials are entered in Plaid Link or the bank's website, never in Connector.

## Set up in the interface

1. Create a [Plaid developer account](https://dashboard.plaid.com/signup). Open **Team Settings → Keys**, or [API keys](https://dashboard.plaid.com/team/keys).
2. In Connector, open **Plaid → Set up**. Copy your Plaid client ID and Sandbox secret into their fields and leave the environment as **Sandbox**. Save the settings. These secrets are encrypted on the server; they are not returned to the browser or AI agent.
3. Choose your bank's country codes (default `US`, for example `US,CA`). Plaid supports selected countries; a country choice does not guarantee support for every institution or product. Taiwan is not in Plaid's current supported country-code list.
4. Click **Connect bank**. Plaid Link opens. In Sandbox, choose a test institution and follow Plaid's test flow. Use only [Plaid's documented Sandbox test credentials](https://plaid.com/docs/sandbox/test-credentials/); this environment does not connect real accounts.
5. Complete Link, then verify the resulting connection. Both connection summaries and action results explicitly say **SANDBOX test data** in Sandbox.
6. For real accounts, obtain Plaid Production access with Transactions enabled and the relevant country coverage. Disconnect the Sandbox institution, change the environment to **Production**, and save the corresponding Production secret. Production access and products may incur Plaid charges.
7. Set a stable public HTTPS workspace address. In the Plaid dashboard's API settings, register the exact redirect shown by Connector: `https://YOUR-HOST/plaid/callback`. Open Connector and sign in at that same HTTPS address before connecting. OAuth banks return to this page; it resumes the original Link session automatically. Localhost Sandbox can test non-OAuth institutions without this redirect.

You can link multiple accounts at the chosen institution if Plaid makes them available, but this version stores one institution per workspace. Disconnect it before choosing a different institution. Disconnect calls Plaid `/item/remove` before removing the local token, including ending the Item's Plaid product subscription. If Plaid cannot confirm removal, the local connection remains available to retry. A bank may retain an entry in its own connected-app list after removal.

## Read bank data from your agent

After connecting Plaid, ask your connected agent to list the available Plaid actions. The available operations are:

- `list-accounts`: account names, types, Plaid account IDs, and at most the last four characters of masked identifiers.
- `read-balances`: current and available balances and currency. Missing balances remain `null`; they are not treated as zero. This read can incur Plaid Balance API charges.
- `read-transactions`: a date range (`startDate`, `endDate`, both `YYYY-MM-DD`), `limit` from 1–100, and `offset` starting at 0. Each response includes a labelled pagination row with `has_more`, `next_offset`, and `total_transactions`. Ask for subsequent pages explicitly. Amounts use Plaid's convention: positive is money leaving an account, negative is money entering.

Transactions reflect Plaid's most recent bank update, rather than a continuous live feed. Initial history can take time; `PRODUCT_NOT_READY` is reported as a request to try again later. Connector uses `/transactions/get` for bounded, on-demand reads and does not maintain a local transaction ledger or webhook synchronization. Plaid recommends `/transactions/sync` when building a persistent synchronized ledger.

Bank data is returned only when an authenticated dashboard or authorized MCP/API client requests a read. That client can see the selected financial results; connect only agents you intend to grant this access. Account summaries contain names and masked identifiers, not balances or transactions. Read results are not written to scheduled job history because these actions cannot be scheduled.

## Connection handling

Link creation and token exchange require the logged-in dashboard session and the app's same-origin request checks. Link flows expire after ten minutes, can be consumed once, and are bound to that session and Plaid environment/client ID. The browser stores only the short-lived Link token and flow ID for OAuth redirect resumption. Plaid access tokens are encrypted on the server and never returned in responses.

Changing the Plaid environment/client ID does not silently retarget an existing Item. Restore the original settings to read or revoke the connection, or disconnect it before changing those settings. If verification fails after token exchange, Connector attempts to revoke the new Item. If revocation also fails, it retains the encrypted credential with an error status so you can verify or disconnect it rather than losing the ability to revoke access.

## Official API contract and verification

Endpoints are fixed to `https://sandbox.plaid.com` or `https://production.plaid.com`, with the `Plaid-Version: 2020-09-14` header. Redirected API requests are rejected. The implementation was checked against [Plaid's official OpenAPI specification](https://github.com/plaid/plaid-openapi/blob/master/2020-09-14.yml), including `/link/token/create`, `/item/public_token/exchange`, `/accounts/get`, `/accounts/balance/get`, `/transactions/get`, and `/item/remove`.

Relevant docs: [Web Link](https://plaid.com/docs/link/web/), [OAuth redirects](https://plaid.com/docs/link/oauth/), [Link API](https://plaid.com/docs/api/link/), [Transactions API](https://plaid.com/docs/api/products/transactions/), [Balance API](https://plaid.com/docs/api/products/balance/), [Item removal](https://plaid.com/docs/api/items/#itemremove).

Contract and security tests use mocked official API responses. No live Sandbox or Production credentials were available during implementation, so real bank authentication and developer-access approval must still be tested with your Plaid account.
