import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

function createServer(env) {
  const server = new McpServer({
    name: "Stem & Vine Eventbrite",
    version: "1.0.0",
  });

  server.registerTool(
    "eventbrite_connection_test",
    {
      description: "Test the connection to Stem & Vine's Eventbrite account.",
      inputSchema: {},
    },
    async () => {
      const response = await fetch(
        "https://www.eventbriteapi.com/v3/users/me/organizations/",
        {
          headers: {
            Authorization: `Bearer ${env.EVENTBRITE_TOKEN}`,
          },
        }
      );

      if (!response.ok) {
        return {
          content: [{
            type: "text",
            text: `Eventbrite returned HTTP ${response.status}`,
          }],
          isError: true,
        };
      }

      const data = await response.json();

      return {
        content: [{
          type: "text",
          text: JSON.stringify(data, null, 2),
        }],
      };
    }
  );

  return server;
}

export default {
  fetch(request, env, ctx) {
    return createMcpHandler(() => createServer(env))(request, env, ctx);
  },
};
