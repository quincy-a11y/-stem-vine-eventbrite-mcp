import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const EVENTBRITE_BASE = "https://www.eventbriteapi.com/v3";
const ORGANIZATION_ID = "2264001212583";

async function eventbrite(env, path) {
  const response = await fetch(`${EVENTBRITE_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${env.EVENTBRITE_TOKEN}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Eventbrite HTTP ${response.status}: ${body.slice(0, 500)}`
    );
  }

  return response.json();
}

function result(data) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function createServer(env) {
  const server = new McpServer({
    name: "Stem & Vine Eventbrite",
    version: "1.1.0",
  });

  // 1. Test connection
  server.registerTool(
    "eventbrite_connection_test",
    {
      description:
        "Test Stem & Vine's Eventbrite connection and return the Eventbrite organization.",
      inputSchema: {},
    },
    async () => {
      try {
        const data = await eventbrite(
          env,
          "/users/me/organizations/"
        );
        return result(data);
      } catch (error) {
        return {
          content: [{ type: "text", text: error.message }],
          isError: true,
        };
      }
    }
  );

  // 2. List Stem & Vine events
  server.registerTool(
    "list_events",
    {
      description:
        "List Stem & Vine Eventbrite events, including upcoming, live, draft, completed, and other events returned by Eventbrite.",
      inputSchema: {},
    },
    async () => {
      try {
        const data = await eventbrite(
          env,
          `/organizations/${ORGANIZATION_ID}/events/?page_size=50`
        );
        return result(data);
      } catch (error) {
        return {
          content: [{ type: "text", text: error.message }],
          isError: true,
        };
      }
    }
  );

  // 3. Get one event
  server.registerTool(
    "get_event",
    {
      description:
        "Get detailed Eventbrite information for one Stem & Vine event using its Eventbrite event ID.",
      inputSchema: {
        event_id: z.string().describe("The Eventbrite event ID"),
      },
    },
    async ({ event_id }) => {
      try {
        const data = await eventbrite(
          env,
          `/events/${encodeURIComponent(event_id)}/?expand=venue,ticket_classes`
        );
        return result(data);
      } catch (error) {
        return {
          content: [{ type: "text", text: error.message }],
          isError: true,
        };
      }
    }
  );

  // 4. Get attendees
  server.registerTool(
    "get_event_attendees",
    {
      description:
        "Get the attendee list and registration information for a Stem & Vine Eventbrite event.",
      inputSchema: {
        event_id: z.string().describe("The Eventbrite event ID"),
      },
    },
    async ({ event_id }) => {
      try {
        const data = await eventbrite(
          env,
          `/events/${encodeURIComponent(event_id)}/attendees/?page_size=50`
        );
        return result(data);
      } catch (error) {
        return {
          content: [{ type: "text", text: error.message }],
          isError: true,
        };
      }
    }
  );

  // 5. Get orders
  server.registerTool(
    "get_event_orders",
    {
      description:
        "Get Eventbrite orders for a Stem & Vine event, including order and purchaser information available from Eventbrite.",
      inputSchema: {
        event_id: z.string().describe("The Eventbrite event ID"),
      },
    },
    async ({ event_id }) => {
      try {
        const data = await eventbrite(
          env,
          `/events/${encodeURIComponent(event_id)}/orders/?page_size=50`
        );
        return result(data);
      } catch (error) {
        return {
          content: [{ type: "text", text: error.message }],
          isError: true,
        };
      }
    }
  );

  // 6. Get ticket classes
  server.registerTool(
    "get_ticket_classes",
    {
      description:
        "Get ticket types, prices, quantities, and ticket availability for a Stem & Vine Eventbrite event.",
      inputSchema: {
        event_id: z.string().describe("The Eventbrite event ID"),
      },
    },
    async ({ event_id }) => {
      try {
        const data = await eventbrite(
          env,
          `/events/${encodeURIComponent(event_id)}/ticket_classes/`
        );
        return result(data);
      } catch (error) {
        return {
          content: [{ type: "text", text: error.message }],
          isError: true,
        };
      }
    }
  );

  return server;
}

export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);

    const authorization = request.headers.get("Authorization");
    const bearerAuthorized =
      env.MCP_API_KEY &&
      authorization === `Bearer ${env.MCP_API_KEY}`;

    const privatePath = `/mcp/${env.MCP_API_KEY}`;
    const pathAuthorized =
      env.MCP_API_KEY &&
      url.pathname === privatePath;

    if (!bearerAuthorized && !pathAuthorized) {
      return new Response("Unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": "Bearer",
        },
      });
    }

    let handlerRequest = request;

    if (pathAuthorized) {
      const rewrittenUrl = new URL(request.url);
      rewrittenUrl.pathname = "/mcp";

      handlerRequest = new Request(rewrittenUrl.toString(), request);
    }

    return createMcpHandler(() => createServer(env))(
      handlerRequest,
      env,
      ctx
    );
  },
};
