import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const EVENTBRITE_BASE = "https://www.eventbriteapi.com/v3";
const ORGANIZATION_ID = "2264001212583";
const EASTERN_TIMEZONE = "America/New_York";

// -----------------------------------------------------------------------------
// Eventbrite HTTP
// -----------------------------------------------------------------------------

async function eventbriteRequest(env, path, options = {}) {
  const response = await fetch(`${EVENTBRITE_BASE}${path}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${env.EVENTBRITE_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    body:
      options.body === undefined
        ? undefined
        : JSON.stringify(options.body),
  });

  const text = await response.text();

  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    throw new Error(
      `Eventbrite HTTP ${response.status}: ${
        typeof data === "string"
          ? data.slice(0, 1500)
          : JSON.stringify(data).slice(0, 1500)
      }`
    );
  }

  return data ?? {};
}

// -----------------------------------------------------------------------------
// Continuation pagination
// -----------------------------------------------------------------------------

async function paginateWithContinuation(
  env,
  basePath,
  resultKey,
  pageSize = 50
) {
  const allItems = [];
  const seenContinuations = new Set();

  let continuation = null;
  let requestCount = 0;

  while (true) {
    requestCount += 1;

    if (requestCount > 100) {
      throw new Error(
        "Pagination stopped after 100 requests as a safety limit."
      );
    }

    const separator = basePath.includes("?") ? "&" : "?";

    let path =
      `${basePath}${separator}` +
      `page_size=${encodeURIComponent(pageSize)}`;

    if (continuation) {
      path +=
        `&continuation=${encodeURIComponent(continuation)}`;
    }

    const data = await eventbriteRequest(env, path);

    const items = Array.isArray(data?.[resultKey])
      ? data[resultKey]
      : [];

    allItems.push(...items);

    const pagination = data?.pagination || {};
    const hasMore = pagination.has_more_items === true;
    const nextContinuation =
      pagination.continuation || null;

    if (!hasMore) break;

    if (!nextContinuation) {
      throw new Error(
        "Eventbrite says more items exist but did not return a continuation token."
      );
    }

    if (seenContinuations.has(nextContinuation)) {
      throw new Error(
        "Eventbrite repeated a continuation token. Pagination stopped."
      );
    }

    seenContinuations.add(nextContinuation);
    continuation = nextContinuation;
  }

  return {
    items: allItems,
    requests_made: requestCount,
  };
}

// -----------------------------------------------------------------------------
// Formatting / MCP results
// -----------------------------------------------------------------------------

function easternDisplay(value) {
  if (!value) return null;

  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: EASTERN_TIMEZONE,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function decorateEvent(event) {
  return {
    ...event,
    stem_vine_display: {
      timezone: EASTERN_TIMEZONE,
      start_eastern: easternDisplay(event?.start?.utc),
      end_eastern: easternDisplay(event?.end?.utc),
    },
  };
}

function successResult(data, summary = "Request completed.") {
  return {
    structuredContent: data,
    content: [
      {
        type: "text",
        text: `${summary}\n${JSON.stringify(data, null, 2)}`,
      },
    ],
  };
}

function errorResult(error) {
  const message =
    error instanceof Error ? error.message : String(error);

  return {
    structuredContent: {
      success: false,
      error: message,
    },
    content: [
      {
        type: "text",
        text: message,
      },
    ],
    isError: true,
  };
}

function requireConfirmation(confirm, preview) {
  if (confirm === true) return null;

  return successResult(
    {
      preview_only: true,
      change_applied: false,
      message:
        "No change has been made. Review this preview. Run the same action again with confirm=true to execute it.",
      preview,
    },
    "Preview only. Nothing was changed."
  );
}

function toUtcIso(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(
      `Invalid date/time: ${value}. Use ISO format with Eastern offset, e.g. 2026-10-03T18:00:00-04:00.`
    );
  }

  return date.toISOString();
}

function cents(value) {
  return Math.round(Number(value) * 100);
}

// -----------------------------------------------------------------------------
// Ownership protection
// -----------------------------------------------------------------------------

function isStemVineEvent(event) {
  return String(event?.organization_id) === ORGANIZATION_ID;
}

async function getOwnedEvent(env, eventId) {
  const event = await eventbriteRequest(
    env,
    `/events/${encodeURIComponent(
      eventId
    )}/?expand=venue,ticket_classes`
  );

  if (!isStemVineEvent(event)) {
    throw new Error(
      `Blocked: event ${eventId} is not owned by Stem & Vine organization ${ORGANIZATION_ID}.`
    );
  }

  return event;
}

// -----------------------------------------------------------------------------
// Server
// -----------------------------------------------------------------------------

function createServer(env) {
  const server = new McpServer({
    name: "Stem & Vine Eventbrite",
    version: "3.0.0",
  });

  // ===========================================================================
  // READ
  // ===========================================================================

  server.registerTool(
    "eventbrite_connection_test",
    {
      description:
        "Verify the private connection to Stem & Vine Baltimore's Eventbrite organization.",
      inputSchema: {},
    },
    async () => {
      try {
        const data = await eventbriteRequest(
          env,
          "/users/me/organizations/"
        );

        const organizations = Array.isArray(data?.organizations)
          ? data.organizations
          : [];

        const organization = organizations.find(
          (org) => String(org.id) === ORGANIZATION_ID
        );

        if (!organization) {
          throw new Error(
            `Stem & Vine organization ${ORGANIZATION_ID} was not found.`
          );
        }

        return successResult({
          connected: true,
          organization_id: ORGANIZATION_ID,
          organization,
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "list_events",
    {
      description:
        "List only Eventbrite events owned by Stem & Vine Baltimore organization 2264001212583. Automatically follows continuation pagination. Never uses public or geographic Eventbrite search.",
      inputSchema: {
        status: z.string().optional(),
        upcoming_only: z.boolean().default(false),
      },
    },
    async ({ status, upcoming_only }) => {
      try {
        const paginated = await paginateWithContinuation(
          env,
          `/organizations/${ORGANIZATION_ID}/events/?order_by=start_asc`,
          "events",
          50
        );

        let events =
          paginated.items.filter(isStemVineEvent);

        if (
          status &&
          String(status).toLowerCase() !== "all"
        ) {
          const requested =
            String(status).toLowerCase();

          events = events.filter(
            (event) =>
              String(event.status || "").toLowerCase() ===
              requested
          );
        }

        if (upcoming_only === true) {
          const now = Date.now();

          events = events.filter((event) => {
            if (!event?.start?.utc) return false;

            const start =
              new Date(event.start.utc).getTime();

            return (
              Number.isFinite(start) &&
              start >= now &&
              String(event.status || "").toLowerCase() !==
                "canceled"
            );
          });
        }

        events.sort((a, b) => {
          const aTime = a?.start?.utc
            ? new Date(a.start.utc).getTime()
            : 0;

          const bTime = b?.start?.utc
            ? new Date(b.start.utc).getTime()
            : 0;

          return aTime - bTime;
        });

        return successResult({
          success: true,
          source: "Stem & Vine private Eventbrite API",
          public_search_used: false,
          organization_id: ORGANIZATION_ID,
          requests_made: paginated.requests_made,
          count: events.length,
          events: events.map(decorateEvent),
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "get_event",
    {
      description:
        "Get one Eventbrite event after verifying that it belongs to Stem & Vine.",
      inputSchema: {
        event_id: z.string(),
      },
    },
    async ({ event_id }) => {
      try {
        const event = await getOwnedEvent(env, event_id);

        return successResult({
          success: true,
          event: decorateEvent(event),
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "get_ticket_classes",
    {
      description:
        "List ticket classes for a Stem & Vine-owned Eventbrite event.",
      inputSchema: {
        event_id: z.string(),
      },
    },
    async ({ event_id }) => {
      try {
        await getOwnedEvent(env, event_id);

        const paginated =
          await paginateWithContinuation(
            env,
            `/events/${encodeURIComponent(
              event_id
            )}/ticket_classes/`,
            "ticket_classes"
          );

        return successResult({
          success: true,
          event_id,
          count: paginated.items.length,
          ticket_classes: paginated.items,
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "get_event_orders",
    {
      description:
        "List all orders for a Stem & Vine-owned Eventbrite event.",
      inputSchema: {
        event_id: z.string(),
      },
    },
    async ({ event_id }) => {
      try {
        await getOwnedEvent(env, event_id);

        const paginated =
          await paginateWithContinuation(
            env,
            `/events/${encodeURIComponent(
              event_id
            )}/orders/`,
            "orders"
          );

        return successResult({
          success: true,
          event_id,
          count: paginated.items.length,
          orders: paginated.items,
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "get_event_attendees",
    {
      description:
        "List all attendees and registrations for a Stem & Vine-owned Eventbrite event, including Eventbrite check-in status.",
      inputSchema: {
        event_id: z.string(),
      },
    },
    async ({ event_id }) => {
      try {
        await getOwnedEvent(env, event_id);

        const paginated =
          await paginateWithContinuation(
            env,
            `/events/${encodeURIComponent(
              event_id
            )}/attendees/`,
            "attendees"
          );

        return successResult({
          success: true,
          event_id,
          count: paginated.items.length,
          attendees: paginated.items,
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "get_registration_summary",
    {
      description:
        "Summarize registrations, orders, ticket classes and check-in status for a Stem & Vine-owned Eventbrite event.",
      inputSchema: {
        event_id: z.string(),
      },
    },
    async ({ event_id }) => {
      try {
        const event =
          await getOwnedEvent(env, event_id);

        const [
          attendees,
          orders,
          tickets,
        ] = await Promise.all([
          paginateWithContinuation(
            env,
            `/events/${encodeURIComponent(
              event_id
            )}/attendees/`,
            "attendees"
          ),
          paginateWithContinuation(
            env,
            `/events/${encodeURIComponent(
              event_id
            )}/orders/`,
            "orders"
          ),
          paginateWithContinuation(
            env,
            `/events/${encodeURIComponent(
              event_id
            )}/ticket_classes/`,
            "ticket_classes"
          ),
        ]);

        return successResult({
          success: true,
          event: decorateEvent(event),
          summary: {
            attendees: attendees.items.length,
            checked_in: attendees.items.filter(
              (a) => a.checked_in === true
            ).length,
            orders: orders.items.length,
            ticket_classes: tickets.items.length,
          },
          ticket_classes: tickets.items,
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "list_venues",
    {
      description:
        "List venues owned by Stem & Vine's Eventbrite organization.",
      inputSchema: {},
    },
    async () => {
      try {
        const paginated =
          await paginateWithContinuation(
            env,
            `/organizations/${ORGANIZATION_ID}/venues/`,
            "venues"
          );

        return successResult({
          success: true,
          organization_id: ORGANIZATION_ID,
          count: paginated.items.length,
          venues: paginated.items,
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ===========================================================================
  // WRITE: EVENT
  // ===========================================================================

  server.registerTool(
    "create_draft_event",
    {
      description:
        "Preview or create a NEW Stem & Vine Eventbrite event as a draft. No event is created unless confirm=true.",
      inputSchema: {
        name: z.string(),
        description_html: z.string().default(""),
        start_local: z.string(),
        end_local: z.string(),
        currency: z.string().default("USD"),
        venue_id: z.string().optional(),
        capacity: z.number().int().positive().optional(),
        online_event: z.boolean().default(false),
        confirm: z.boolean().default(false),
      },
    },
    async ({
      name,
      description_html,
      start_local,
      end_local,
      currency,
      venue_id,
      capacity,
      online_event,
      confirm,
    }) => {
      try {
        const payload = {
          name: { html: name },
          description: { html: description_html },
          start: {
            timezone: EASTERN_TIMEZONE,
            utc: toUtcIso(start_local),
          },
          end: {
            timezone: EASTERN_TIMEZONE,
            utc: toUtcIso(end_local),
          },
          currency,
          online_event,
        };

        if (venue_id) payload.venue_id = venue_id;
        if (capacity) payload.capacity = capacity;

        const confirmation =
          requireConfirmation(confirm, {
            action: "create_draft_event",
            organization_id: ORGANIZATION_ID,
            event: payload,
            note:
              "The new event will be created as a draft. It will not be published.",
          });

        if (confirmation) return confirmation;

        const created =
          await eventbriteRequest(
            env,
            `/organizations/${ORGANIZATION_ID}/events/`,
            {
              method: "POST",
              body: {
                event: payload,
              },
            }
          );

        if (!isStemVineEvent(created)) {
          throw new Error(
            "Eventbrite returned an event outside the Stem & Vine organization."
          );
        }

        return successResult({
          success: true,
          created_as_draft: true,
          event: decorateEvent(created),
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "update_event",
    {
      description:
        "Preview or update a Stem & Vine Eventbrite event. No change is made unless confirm=true.",
      inputSchema: {
        event_id: z.string(),
        name: z.string().optional(),
        description_html: z.string().optional(),
        start_local: z.string().optional(),
        end_local: z.string().optional(),
        venue_id: z.string().optional(),
        capacity: z.number().int().positive().optional(),
        confirm: z.boolean().default(false),
      },
    },
    async ({
      event_id,
      name,
      description_html,
      start_local,
      end_local,
      venue_id,
      capacity,
      confirm,
    }) => {
      try {
        const existing =
          await getOwnedEvent(env, event_id);

        const changes = {};

        if (name !== undefined) {
          changes.name = { html: name };
        }

        if (description_html !== undefined) {
          changes.description = {
            html: description_html,
          };
        }

        if (start_local !== undefined) {
          changes.start = {
            timezone: EASTERN_TIMEZONE,
            utc: toUtcIso(start_local),
          };
        }

        if (end_local !== undefined) {
          changes.end = {
            timezone: EASTERN_TIMEZONE,
            utc: toUtcIso(end_local),
          };
        }

        if (venue_id !== undefined) {
          changes.venue_id = venue_id;
        }

        if (capacity !== undefined) {
          changes.capacity = capacity;
        }

        if (!Object.keys(changes).length) {
          throw new Error(
            "No update fields were provided."
          );
        }

        const confirmation =
          requireConfirmation(confirm, {
            action: "update_event",
            event_id,
            event_name: existing?.name?.text,
            proposed_changes: changes,
          });

        if (confirmation) return confirmation;

        const updated =
          await eventbriteRequest(
            env,
            `/events/${encodeURIComponent(event_id)}/`,
            {
              method: "POST",
              body: {
                event: changes,
              },
            }
          );

        return successResult({
          success: true,
          event: decorateEvent(updated),
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "copy_event",
    {
      description:
        "Preview or duplicate an existing Stem & Vine Eventbrite event. Requires confirm=true.",
      inputSchema: {
        event_id: z.string(),
        confirm: z.boolean().default(false),
      },
    },
    async ({ event_id, confirm }) => {
      try {
        const existing =
          await getOwnedEvent(env, event_id);

        const confirmation =
          requireConfirmation(confirm, {
            action: "copy_event",
            event_id,
            event_name: existing?.name?.text,
            note:
              "Eventbrite will create a duplicate with a new event ID.",
          });

        if (confirmation) return confirmation;

        const copied =
          await eventbriteRequest(
            env,
            `/events/${encodeURIComponent(
              event_id
            )}/copy/`,
            {
              method: "POST",
              body: {},
            }
          );

        return successResult({
          success: true,
          copied_event: decorateEvent(copied),
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ===========================================================================
  // WRITE: TICKETS
  // ===========================================================================

  server.registerTool(
    "create_ticket_class",
    {
      description:
        "Preview or create a ticket type for a Stem & Vine event. Requires confirm=true.",
      inputSchema: {
        event_id: z.string(),
        name: z.string(),
        quantity_total: z.number().int().positive(),
        free: z.boolean().default(false),
        price_usd: z.number().nonnegative().optional(),
        sales_start_local: z.string().optional(),
        sales_end_local: z.string().optional(),
        confirm: z.boolean().default(false),
      },
    },
    async ({
      event_id,
      name,
      quantity_total,
      free,
      price_usd,
      sales_start_local,
      sales_end_local,
      confirm,
    }) => {
      try {
        await getOwnedEvent(env, event_id);

        if (!free && price_usd === undefined) {
          throw new Error(
            "price_usd is required for a paid ticket."
          );
        }

        const ticket = {
          name,
          quantity_total,
          free,
        };

        if (!free) {
          ticket.cost =
            `USD,${cents(price_usd)}`;
        }

        if (sales_start_local) {
          ticket.sales_start =
            toUtcIso(sales_start_local);
        }

        if (sales_end_local) {
          ticket.sales_end =
            toUtcIso(sales_end_local);
        }

        const confirmation =
          requireConfirmation(confirm, {
            action: "create_ticket_class",
            event_id,
            ticket,
          });

        if (confirmation) return confirmation;

        const created =
          await eventbriteRequest(
            env,
            `/events/${encodeURIComponent(
              event_id
            )}/ticket_classes/`,
            {
              method: "POST",
              body: {
                ticket_class: ticket,
              },
            }
          );

        return successResult({
          success: true,
          ticket_class: created,
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "update_ticket_class",
    {
      description:
        "Preview or update ticket name, price, quantity or sale dates. Requires confirm=true.",
      inputSchema: {
        event_id: z.string(),
        ticket_class_id: z.string(),
        name: z.string().optional(),
        quantity_total: z
          .number()
          .int()
          .positive()
          .optional(),
        free: z.boolean().optional(),
        price_usd: z.number().nonnegative().optional(),
        sales_start_local: z.string().optional(),
        sales_end_local: z.string().optional(),
        confirm: z.boolean().default(false),
      },
    },
    async ({
      event_id,
      ticket_class_id,
      name,
      quantity_total,
      free,
      price_usd,
      sales_start_local,
      sales_end_local,
      confirm,
    }) => {
      try {
        await getOwnedEvent(env, event_id);

        const current =
          await eventbriteRequest(
            env,
            `/events/${encodeURIComponent(
              event_id
            )}/ticket_classes/${encodeURIComponent(
              ticket_class_id
            )}/`
          );

        const changes = {};

        if (name !== undefined) changes.name = name;

        if (quantity_total !== undefined) {
          changes.quantity_total =
            quantity_total;
        }

        if (free !== undefined) {
          changes.free = free;
        }

        if (price_usd !== undefined) {
          changes.free = false;
          changes.cost =
            `USD,${cents(price_usd)}`;
        }

        if (sales_start_local !== undefined) {
          changes.sales_start =
            toUtcIso(sales_start_local);
        }

        if (sales_end_local !== undefined) {
          changes.sales_end =
            toUtcIso(sales_end_local);
        }

        if (!Object.keys(changes).length) {
          throw new Error(
            "No ticket changes were provided."
          );
        }

        const confirmation =
          requireConfirmation(confirm, {
            action: "update_ticket_class",
            event_id,
            ticket_class_id,
            current,
            proposed_changes: changes,
          });

        if (confirmation) return confirmation;

        const updated =
          await eventbriteRequest(
            env,
            `/events/${encodeURIComponent(
              event_id
            )}/ticket_classes/${encodeURIComponent(
              ticket_class_id
            )}/`,
            {
              method: "POST",
              body: {
                ticket_class: changes,
              },
            }
          );

        return successResult({
          success: true,
          ticket_class: updated,
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ===========================================================================
  // WRITE: VENUES
  // ===========================================================================

  server.registerTool(
    "create_venue",
    {
      description:
        "Preview or create a venue under Stem & Vine's Eventbrite organization. Requires confirm=true.",
      inputSchema: {
        name: z.string(),
        address_1: z.string(),
        city: z.string(),
        region: z.string().default("MD"),
        postal_code: z.string(),
        country: z.string().default("US"),
        confirm: z.boolean().default(false),
      },
    },
    async ({
      name,
      address_1,
      city,
      region,
      postal_code,
      country,
      confirm,
    }) => {
      try {
        const venue = {
          name,
          address: {
            address_1,
            city,
            region,
            postal_code,
            country,
          },
        };

        const confirmation =
          requireConfirmation(confirm, {
            action: "create_venue",
            organization_id: ORGANIZATION_ID,
            venue,
          });

        if (confirmation) return confirmation;

        const created =
          await eventbriteRequest(
            env,
            `/organizations/${ORGANIZATION_ID}/venues/`,
            {
              method: "POST",
              body: { venue },
            }
          );

        return successResult({
          success: true,
          venue: created,
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "update_venue",
    {
      description:
        "Preview or update an Eventbrite venue used by Stem & Vine. Requires confirm=true.",
      inputSchema: {
        venue_id: z.string(),
        name: z.string().optional(),
        address_1: z.string().optional(),
        city: z.string().optional(),
        region: z.string().optional(),
        postal_code: z.string().optional(),
        country: z.string().optional(),
        confirm: z.boolean().default(false),
      },
    },
    async ({
      venue_id,
      name,
      address_1,
      city,
      region,
      postal_code,
      country,
      confirm,
    }) => {
      try {
        const current =
          await eventbriteRequest(
            env,
            `/venues/${encodeURIComponent(
              venue_id
            )}/`
          );

        const venue = {};

        if (name !== undefined) venue.name = name;

        const address = {};

        if (address_1 !== undefined) {
          address.address_1 = address_1;
        }

        if (city !== undefined) address.city = city;
        if (region !== undefined) address.region = region;

        if (postal_code !== undefined) {
          address.postal_code = postal_code;
        }

        if (country !== undefined) {
          address.country = country;
        }

        if (Object.keys(address).length) {
          venue.address = address;
        }

        if (!Object.keys(venue).length) {
          throw new Error(
            "No venue changes were provided."
          );
        }

        const confirmation =
          requireConfirmation(confirm, {
            action: "update_venue",
            venue_id,
            current,
            proposed_changes: venue,
          });

        if (confirmation) return confirmation;

        const updated =
          await eventbriteRequest(
            env,
            `/venues/${encodeURIComponent(
              venue_id
            )}/`,
            {
              method: "POST",
              body: { venue },
            }
          );

        return successResult({
          success: true,
          venue: updated,
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ===========================================================================
  // CONSEQUENTIAL EVENT ACTIONS
  // ===========================================================================

  server.registerTool(
    "publish_event",
    {
      description:
        "Preview or publish a Stem & Vine event. Requires confirm=true.",
      inputSchema: {
        event_id: z.string(),
        confirm: z.boolean().default(false),
      },
    },
    async ({ event_id, confirm }) => {
      try {
        const event =
          await getOwnedEvent(env, event_id);

        const confirmation =
          requireConfirmation(confirm, {
            action: "publish_event",
            event: decorateEvent(event),
            warning:
              "Publishing makes the event live/public if Eventbrite validation passes.",
          });

        if (confirmation) return confirmation;

        const response =
          await eventbriteRequest(
            env,
            `/events/${encodeURIComponent(
              event_id
            )}/publish/`,
            {
              method: "POST",
              body: {},
            }
          );

        return successResult({
          success: true,
          event_id,
          response,
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "unpublish_event",
    {
      description:
        "Preview or unpublish a Stem & Vine event. Requires confirm=true.",
      inputSchema: {
        event_id: z.string(),
        confirm: z.boolean().default(false),
      },
    },
    async ({ event_id, confirm }) => {
      try {
        const event =
          await getOwnedEvent(env, event_id);

        const confirmation =
          requireConfirmation(confirm, {
            action: "unpublish_event",
            event: decorateEvent(event),
            warning:
              "Eventbrite may reject unpublishing when orders exist.",
          });

        if (confirmation) return confirmation;

        const response =
          await eventbriteRequest(
            env,
            `/events/${encodeURIComponent(
              event_id
            )}/unpublish/`,
            {
              method: "POST",
              body: {},
            }
          );

        return successResult({
          success: true,
          event_id,
          response,
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "cancel_event",
    {
      description:
        "Preview or cancel a Stem & Vine Eventbrite event. Requires confirm=true.",
      inputSchema: {
        event_id: z.string(),
        confirm: z.boolean().default(false),
      },
    },
    async ({ event_id, confirm }) => {
      try {
        const event =
          await getOwnedEvent(env, event_id);

        const confirmation =
          requireConfirmation(confirm, {
            action: "cancel_event",
            event: decorateEvent(event),
            warning:
              "Cancellation is consequential and Eventbrite may reject it if orders exist.",
          });

        if (confirmation) return confirmation;

        const response =
          await eventbriteRequest(
            env,
            `/events/${encodeURIComponent(
              event_id
            )}/cancel/`,
            {
              method: "POST",
              body: {},
            }
          );

        return successResult({
          success: true,
          event_id,
          response,
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "delete_event",
    {
      description:
        "Preview or permanently delete a Stem & Vine Eventbrite event. Requires confirm=true.",
      inputSchema: {
        event_id: z.string(),
        confirm: z.boolean().default(false),
      },
    },
    async ({ event_id, confirm }) => {
      try {
        const event =
          await getOwnedEvent(env, event_id);

        const confirmation =
          requireConfirmation(confirm, {
            action: "delete_event",
            event: decorateEvent(event),
            warning:
              "Deletion is destructive. Eventbrite only permits deletion when the event has no pending or completed orders.",
          });

        if (confirmation) return confirmation;

        const response =
          await eventbriteRequest(
            env,
            `/events/${encodeURIComponent(
              event_id
            )}/`,
            {
              method: "DELETE",
            }
          );

        return successResult({
          success: true,
          deleted_event_id: event_id,
          response,
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  return server;
}

// -----------------------------------------------------------------------------
// Private MCP endpoint
// -----------------------------------------------------------------------------

export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);

    const authorization =
      request.headers.get("Authorization");

    const bearerAuthorized =
      env.MCP_API_KEY &&
      authorization ===
        `Bearer ${env.MCP_API_KEY}`;

    const privatePath =
      `/mcp/${env.MCP_API_KEY}`;

    const pathAuthorized =
      env.MCP_API_KEY &&
      url.pathname === privatePath;

    if (
      !bearerAuthorized &&
      !pathAuthorized
    ) {
      return new Response(
        "Unauthorized",
        {
          status: 401,
          headers: {
            "WWW-Authenticate": "Bearer",
          },
        }
      );
    }

    let handlerRequest = request;

    if (pathAuthorized) {
      const rewrittenUrl =
        new URL(request.url);

      rewrittenUrl.pathname = "/mcp";

      handlerRequest =
        new Request(
          rewrittenUrl.toString(),
          request
        );
    }

    return createMcpHandler(
      () => createServer(env)
    )(
      handlerRequest,
      env,
      ctx
    );
  },
};
