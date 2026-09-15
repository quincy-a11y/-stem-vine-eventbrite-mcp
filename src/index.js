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
          ? data.slice(0, 1000)
          : JSON.stringify(data).slice(0, 1000)
      }`
    );
  }

  return data ?? {};
}

// -----------------------------------------------------------------------------
// Pagination
// IMPORTANT: Eventbrite is returning continuation-token pagination for this
// organization. We follow pagination.continuation, not page=2/page=3.
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

    if (!hasMore) {
      break;
    }

    if (!nextContinuation) {
      throw new Error(
        "Eventbrite says more items exist but did not return a continuation token."
      );
    }

    if (seenContinuations.has(nextContinuation)) {
      throw new Error(
        "Eventbrite returned the same continuation token twice. Pagination stopped to prevent an infinite loop."
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
// Formatting
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
// MCP SERVER
// -----------------------------------------------------------------------------

function createServer(env) {
  const server = new McpServer({
    name: "Stem & Vine Eventbrite",
    version: "2.1.0",
  });

  // ===========================================================================
  // CONNECTION TEST
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

        const organizations = Array.isArray(
          data?.organizations
        )
          ? data.organizations
          : [];

        const organization = organizations.find(
          (org) =>
            String(org.id) === ORGANIZATION_ID
        );

        if (!organization) {
          throw new Error(
            `Required Stem & Vine organization ${ORGANIZATION_ID} was not found.`
          );
        }

        return successResult(
          {
            connected: true,
            organization_id: ORGANIZATION_ID,
            organization,
          },
          `Connected to ${organization.name || "Stem & Vine Baltimore"}.`
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ===========================================================================
  // LIST EVENTS
  // THIS IS THE IMPORTANT REPAIR.
  // ===========================================================================

  server.registerTool(
    "list_events",
    {
      description:
        "List only Eventbrite events owned by Stem & Vine Baltimore organization 2264001212583. Automatically follows all Eventbrite continuation tokens. Never performs public, nearby, venue, or geographic Eventbrite search.",
      inputSchema: {
        status: z
          .string()
          .optional()
          .describe(
            "Optional local status filter such as live, draft, canceled, completed, started, or ended. Omit or use 'all' for all statuses."
          ),

        upcoming_only: z
          .boolean()
          .default(false)
          .describe(
            "When true, return only events whose start time has not passed. Filtering is performed after all Eventbrite pages are retrieved."
          ),
      },
    },

    async ({ status, upcoming_only }) => {
      try {
        // We deliberately do not rely on Eventbrite status/time filters here.
        // Retrieve the complete owned event set first.
        const paginated =
          await paginateWithContinuation(
            env,
            `/organizations/${ORGANIZATION_ID}/events/?order_by=start_asc`,
            "events",
            50
          );

        // SECURITY / OWNERSHIP FILTER
        let events = paginated.items.filter(
          isStemVineEvent
        );

        const totalReturnedByEventbrite =
          paginated.items.length;

        const removedForWrongOrganization =
          totalReturnedByEventbrite -
          events.length;

        // LOCAL STATUS FILTER
        if (
          status &&
          status.toLowerCase() !== "all"
        ) {
          const requestedStatus =
            status.toLowerCase();

          events = events.filter(
            (event) =>
              String(event.status || "").toLowerCase() ===
              requestedStatus
          );
        }

        // LOCAL UPCOMING FILTER
        if (upcoming_only === true) {
          const now = Date.now();

          events = events.filter((event) => {
            const utc = event?.start?.utc;

            if (!utc) return false;

            const startTime = new Date(utc).getTime();

            return (
              Number.isFinite(startTime) &&
              startTime >= now &&
              String(
                event.status || ""
              ).toLowerCase() !== "canceled"
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

        const decorated =
          events.map(decorateEvent);

        const structured = {
          success: true,

          source: "Stem & Vine private Eventbrite API",

          organization: {
            name: "Stem & Vine Baltimore",
            id: ORGANIZATION_ID,
          },

          public_search_used: false,

          pagination: {
            strategy:
              "Eventbrite continuation token",
            requests_made:
              paginated.requests_made,
            total_returned_by_eventbrite:
              totalReturnedByEventbrite,
            wrong_organization_records_removed:
              removedForWrongOrganization,
          },

          filters: {
            status: status || "all",
            upcoming_only:
              upcoming_only === true,
          },

          count: decorated.length,

          events: decorated,
        };

        return successResult(
          structured,
          `Retrieved ${decorated.length} Stem & Vine-owned Eventbrite events across ${paginated.requests_made} Eventbrite request(s).`
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ===========================================================================
  // GET ONE EVENT
  // ===========================================================================

  server.registerTool(
    "get_event",
    {
      description:
        "Get one Eventbrite event only after verifying it belongs to Stem & Vine organization 2264001212583.",
      inputSchema: {
        event_id: z
          .string()
          .describe(
            "The Eventbrite event ID."
          ),
      },
    },
    async ({ event_id }) => {
      try {
        const event =
          await getOwnedEvent(
            env,
            event_id
          );

        return successResult(
          {
            success: true,
            organization_id:
              ORGANIZATION_ID,
            event:
              decorateEvent(event),
          },
          `Retrieved Stem & Vine event ${event_id}.`
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ===========================================================================
  // TICKETS
  // ===========================================================================

  server.registerTool(
    "get_ticket_classes",
    {
      description:
        "List all ticket classes for a Stem & Vine-owned Eventbrite event.",
      inputSchema: {
        event_id: z.string(),
      },
    },
    async ({ event_id }) => {
      try {
        await getOwnedEvent(
          env,
          event_id
        );

        const paginated =
          await paginateWithContinuation(
            env,
            `/events/${encodeURIComponent(
              event_id
            )}/ticket_classes/`,
            "ticket_classes",
            50
          );

        return successResult(
          {
            success: true,
            organization_id:
              ORGANIZATION_ID,
            event_id,
            count:
              paginated.items.length,
            pagination_requests:
              paginated.requests_made,
            ticket_classes:
              paginated.items,
          },
          `Retrieved ${paginated.items.length} ticket class(es).`
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ===========================================================================
  // ORDERS
  // ===========================================================================

  server.registerTool(
    "get_event_orders",
    {
      description:
        "List all orders for a Stem & Vine-owned Eventbrite event, automatically following Eventbrite continuation pagination.",
      inputSchema: {
        event_id: z.string(),
      },
    },
    async ({ event_id }) => {
      try {
        await getOwnedEvent(
          env,
          event_id
        );

        const paginated =
          await paginateWithContinuation(
            env,
            `/events/${encodeURIComponent(
              event_id
            )}/orders/`,
            "orders",
            50
          );

        return successResult(
          {
            success: true,
            organization_id:
              ORGANIZATION_ID,
            event_id,
            count:
              paginated.items.length,
            pagination_requests:
              paginated.requests_made,
            orders:
              paginated.items,
          },
          `Retrieved ${paginated.items.length} order(s).`
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ===========================================================================
  // ATTENDEES
  // ===========================================================================

  server.registerTool(
    "get_event_attendees",
    {
      description:
        "List all attendees/registrations for a Stem & Vine-owned Eventbrite event, automatically following continuation pagination and preserving Eventbrite check-in status.",
      inputSchema: {
        event_id: z.string(),
      },
    },
    async ({ event_id }) => {
      try {
        await getOwnedEvent(
          env,
          event_id
        );

        const paginated =
          await paginateWithContinuation(
            env,
            `/events/${encodeURIComponent(
              event_id
            )}/attendees/`,
            "attendees",
            50
          );

        return successResult(
          {
            success: true,
            organization_id:
              ORGANIZATION_ID,
            event_id,
            count:
              paginated.items.length,
            pagination_requests:
              paginated.requests_made,
            attendees:
              paginated.items,
          },
          `Retrieved ${paginated.items.length} attendee registration(s).`
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ===========================================================================
  // REGISTRATION SUMMARY
  // ===========================================================================

  server.registerTool(
    "get_registration_summary",
    {
      description:
        "Summarize attendees, orders, check-ins and ticket classes for a Stem & Vine-owned event.",
      inputSchema: {
        event_id: z.string(),
      },
    },
    async ({ event_id }) => {
      try {
        const event =
          await getOwnedEvent(
            env,
            event_id
          );

        const [
          attendeesResult,
          ordersResult,
          ticketsResult,
        ] = await Promise.all([
          paginateWithContinuation(
            env,
            `/events/${encodeURIComponent(
              event_id
            )}/attendees/`,
            "attendees",
            50
          ),

          paginateWithContinuation(
            env,
            `/events/${encodeURIComponent(
              event_id
            )}/orders/`,
            "orders",
            50
          ),

          paginateWithContinuation(
            env,
            `/events/${encodeURIComponent(
              event_id
            )}/ticket_classes/`,
            "ticket_classes",
            50
          ),
        ]);

        const attendees =
          attendeesResult.items;

        const checkedIn =
          attendees.filter(
            (a) =>
              a.checked_in === true
          ).length;

        const attending =
          attendees.filter(
            (a) =>
              String(
                a.status || ""
              ).toLowerCase() ===
              "attending"
          ).length;

        return successResult(
          {
            success: true,

            organization_id:
              ORGANIZATION_ID,

            event:
              decorateEvent(event),

            summary: {
              attendee_registrations:
                attendees.length,

              attending,

              checked_in:
                checkedIn,

              orders:
                ordersResult.items
                  .length,

              ticket_classes:
                ticketsResult.items
                  .length,
            },

            ticket_classes:
              ticketsResult.items,
          },
          `Registration summary for ${event?.name?.text || event_id}.`
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  return server;
}

// -----------------------------------------------------------------------------
// PRIVATE MCP ENDPOINT
// -----------------------------------------------------------------------------

export default {
  fetch(request, env, ctx) {
    const url =
      new URL(request.url);

    const authorization =
      request.headers.get(
        "Authorization"
      );

    const bearerAuthorized =
      env.MCP_API_KEY &&
      authorization ===
        `Bearer ${env.MCP_API_KEY}`;

    const privatePath =
      `/mcp/${env.MCP_API_KEY}`;

    const pathAuthorized =
      env.MCP_API_KEY &&
      url.pathname ===
        privatePath;

    if (
      !bearerAuthorized &&
      !pathAuthorized
    ) {
      return new Response(
        "Unauthorized",
        {
          status: 401,
          headers: {
            "WWW-Authenticate":
              "Bearer",
          },
        }
      );
    }

    let handlerRequest =
      request;

    if (pathAuthorized) {
      const rewrittenUrl =
        new URL(request.url);

      rewrittenUrl.pathname =
        "/mcp";

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
