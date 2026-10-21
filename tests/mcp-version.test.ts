// @vitest-environment node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { version } from "../package.json";
import { createMcpServer } from "../src/mcp/server";

describe("MCP server version", () => {
  it("reports the package.json version", async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await createMcpServer({ origin: "http://127.0.0.1:1" }).connect(
      serverTransport,
    );
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);
    expect(client.getServerVersion()).toMatchObject({
      name: "screencheck",
      version,
    });
    await client.close();
  });
});
