Here is the handoff from my newer conversation about the Stem & Vine Eventbrite integration:

We confirmed that the custom app is connected to the correct Eventbrite organization:

* App: Stem & Vine Eventbrite
* Development app ID: dev-6aa96472c46081919300cc14e54aec88
* Eventbrite organization: Stem & Vine Baltimore
* Organization ID: 2264001212583

The connection works, but the MCP server currently gives ChatGPT only one tool: `eventbrite_connection_test`. That tool confirms the account but does not retrieve or manage events.

Because there was no account-specific event-listing tool, ChatGPT incorrectly used public Eventbrite search results. This mixed events merely held at Stem & Vine with events actually published by Stem & Vine. Do not use geographic, venue, or public search results as a substitute.

The connector needs full read-and-write capabilities.

Required read tools:

* List Stem & Vine’s upcoming, past, draft, and canceled events
* Get a specific event
* List ticket types, prices, inventory, and sales
* List orders and registrations
* List attendees and check-in status
* Read venue, schedule, capacity, and event status

Required write tools:

* Create a draft event
* Update an event
* Create and update ticket types
* Update ticket quantity, price, and sale dates
* Publish an event
* Unpublish an event
* Check attendees in or out
* Delete or cancel an event

Important safeguards:

* Hard-code organization ID `2264001212583`.
* Only retrieve events owned by that organization.
* Never use Eventbrite’s nearby-event or location search.
* Create new events as drafts first.
* Show me a preview before making changes.
* Require confirmation before publishing, unpublishing, deleting, canceling, checking attendees in, or changing ticket inventory.
* Keep all Eventbrite credentials on the server.
* Display times in Eastern Time.
* Handle pagination so no events or attendees are missed.

The custom app was created through ChatGPT Developer Mode. It should be located under:

* Settings → Apps → Enabled Apps → Stem & Vine Eventbrite, or
* Workspace Settings → Apps → Drafts → Stem & Vine Eventbrite

It will have a “Dev” label.

The missing work must be completed on the remote MCP server whose address was entered when the custom app was created. After updating that server, ChatGPT must scan or refresh the tools so the new read/write actions appear.

Please continue from where we originally built the MCP server. Identify the hosting platform, project, files, and server address we previously used, then help me add the tools above. Do not ask me to remember or reconstruct steps already completed in this original conversation.
