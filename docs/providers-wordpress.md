# WordPress on your own hosting provider

Use **WordPress (your hosting provider)** when your website runs on hosting such as Bluehost, SiteGround, Hostinger, WP Engine, or your own server. Connector calls the website's official WordPress REST API directly. No WordPress.com account, Jetpack connection, developer application, or terminal command is needed.

This connection lets your AI agent list and read blog posts and pages, create drafts, publish new content, and edit existing content. Adding it leaves your other connected accounts in place. The separate **WordPress** connection for WordPress.com and eligible Jetpack sites keeps its existing credentials and actions.

## Connect once from the dashboard

1. Open your website in your browser. Copy its HTTPS address, for example `https://example.com`. If WordPress is installed in a subdirectory, include that part, such as `https://example.com/blog`. Use the website's final address after redirects. Do not include `/wp-admin`, `/wp-json`, or the address of an individual page.
2. Open the website's WordPress dashboard. Usually this is your website address followed by `/wp-admin`, such as `https://example.com/wp-admin`.
3. Sign in with your **WordPress** username and password. These may differ from the login for your hosting company.
4. In the WordPress sidebar, click **Users**, then **Profile**. Some roles show **Profile** directly in the sidebar.
5. Find the **Username** field and note that username. Connector needs this WordPress username.
6. Scroll down to **Application Passwords**. This feature requires WordPress 5.6 or newer and HTTPS; the hosting company or a security plugin may disable it.
7. In **New Application Password Name**, enter `Connector AI`.
8. Click **Add New Application Password**.
9. WordPress displays a generated password, usually in groups of letters and numbers separated by spaces. Select and copy the entire generated password. WordPress only displays it once. Keep this page open until the connection succeeds.
10. Open Connector and select **Connections**.
11. Find **WordPress (your hosting provider)** and click **Connect account**.
12. Paste the generated password into **Application password**. Use this generated password, rather than the normal password you use to sign into WordPress.
13. Enter the website HTTPS address from step 1 in **WordPress website HTTPS URL**.
14. Enter the username from step 5 in **WordPress username**.
15. Click **Connect account**. Connector checks the account by reading the current WordPress user profile. It does not create a test post.
16. Wait for the account to show as connected. Your website and available editing/publishing permissions appear in the connection details.

An **Editor** can generally create, publish, and edit both posts and pages. An **Author** normally manages their own posts and cannot edit pages. A Contributor may save post drafts but needs editorial approval to publish. WordPress enforces the connected user's permissions for every operation.

Connector stores the Application Password in its encrypted credential store. To revoke just this connection, use WordPress **Users → Profile → Application Passwords**, find `Connector AI`, and click **Revoke**. You would then need to create a replacement password to reconnect this website.

## Use it through your AI agent

Your existing Grok/AI connection to Connector can discover this platform under provider ID `wordpress-self-hosted`. After connecting the website, ask the agent to refresh its Connector account list. If the client caches available connections, refresh the connector in that client's settings.

Examples:

- “List the pages on my WordPress website and show me their IDs.”
- “Read my About page, then prepare the wording changes I describe. Keep its current publication status.”
- “Save this article as a new WordPress draft titled ‘October update’.”
- “Publish this new WordPress blog post now.”
- “Schedule this new WordPress post for tomorrow at 9 AM Taipei time.”

Writes use the existing Connector confirmation and request-ID flow. The agent should obtain your authorization for the content and target before applying an edit or publication. The write result reports the **status returned by WordPress**; a successful request with status `pending` does not mean the content is public.

## Available actions

| Action ID | What it does |
| --- | --- |
| `posts`, `pages` | List up to 25 items at a time, including permitted drafts. Set `page` to the next result page to continue. |
| `read-post`, `read-page` | Read one item by `postId` or `pageId`, including its complete editable source. |
| `create-post`, `create-page` | Create a draft by default. Optional statuses are `draft`, `pending`, and `private`. |
| `publish`, `publish-page` | Create a **new** public post or page. These actions can be scheduled by Connector. |
| `update-post`, `update-page` | Update specified fields of an existing item. Set `status` to `publish` to publish an existing draft. |

Creation requires `title` and `content`. Posts also accept `excerpt` and `slug`; pages accept `slug` and `parentId`. Set a page's `parentId` to `0` for a top-level page. WordPress may normalize slugs and filter HTML according to the user's permissions.

For edits, blank or omitted fields remain unchanged. A supplied `content` value replaces the whole content field, so the agent should read the existing source first and preserve WordPress block markup it does not intend to change. An omitted `status` preserves the current publication state. This release does not provide a separate “clear field” operation.

Scheduled publications run through Connector's existing queue. **Keep Connector running at the scheduled time.** Pending jobs that become due while the app is stopped run after it restarts. This connector does not create a native WordPress `future` publication or schedule edits to existing content.

## Website requirements and scope

- The website must be reachable on public HTTPS with a valid TLS certificate. Local/private-network sites are not supported.
- WordPress must expose the standard REST routes under `/wp-json/wp/v2/`. Its usual permalink/REST configuration must be enabled; a site that only exposes REST via `?rest_route=` is not supported by this connector.
- Use the final hostname and subdirectory rather than a URL that redirects. Connector does not forward an Application Password through a redirect.
- Security plugins, hosting firewalls, and reverse proxies must permit the REST API and forward the HTTP Authorization header to WordPress. If the credentials are correct but the connection returns an authorization error, ask your hosting provider to check those settings.
- This release edits standard WordPress post/page content. Theme templates, menus, custom post types, media uploads, and page-builder data stored in plugin-specific fields need separate supported actions. It does not modify WordPress plugins or server files.

## Official references

- [WordPress REST API authentication and Application Passwords](https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/)
- [Posts reference](https://developer.wordpress.org/rest-api/reference/posts/)
- [Pages reference](https://developer.wordpress.org/rest-api/reference/pages/)
- [Users reference](https://developer.wordpress.org/rest-api/reference/users/)
- [WordPress core posts/pages REST controller](https://github.com/WordPress/WordPress/blob/master/wp-includes/rest-api/endpoints/class-wp-rest-posts-controller.php)
- [WordPress core users REST controller](https://github.com/WordPress/WordPress/blob/master/wp-includes/rest-api/endpoints/class-wp-rest-users-controller.php)
