/**
 * A real MCP client against the hosted server, shared by the scripts here.
 *
 * The SDK's own client rather than hand-rolled JSON-RPC, deliberately: these
 * scripts exist to prove the server works for the clients people actually
 * point at it, and a bespoke client would prove only that it works for a
 * bespoke client. Streamable HTTP is the transport every remote MCP client
 * speaks — Claude Code, Claude Desktop, Cursor, Zed.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/** The public deployment. Override with `mcp_url=` to test a dev copy. */
export const MCP_URL: string =
  process.env['mcp_url'] ?? 'https://mcp.xhr.dev/mcp';

export const log = (message: string, ...extra: unknown[]): void =>
  console.log(`[${new Date().toISOString()}] ${message}`, ...extra);

export type ToolResult = {
  content: { text: string; type: string }[];
  isError?: boolean;
};

/**
 * `headers` is the whole configuration surface of the hosted server: no
 * headers means the shared trial box on its own key, `x-api-key` and
 * `x-solver-host` mean yours.
 */
export const connect = async (
  headers: Record<string, string> = {}
): Promise<Client> => {
  const client = new Client({ name: 'xhrdev-examples', version: '1.0.0' });

  // The SDK's own `sessionId` getter returns `string | undefined`, which
  // `exactOptionalPropertyTypes` treats as incompatible with the `Transport`
  // interface's `sessionId?: string` — a strictness mismatch in the SDK's own
  // types, not a real incompatibility.
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers },
    }) as Transport
  );

  return client;
};

/** Calls a tool and fails loudly, rather than returning an error as content. */
export const callTool = async (
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<unknown> => {
  const result = (await client.callTool(
    { arguments: args, name },
    undefined,
    // Well past the server's own 55s ceiling, so a timeout here is the
    // server's answer rather than this client giving up first.
    { timeout: 90_000 }
  )) as ToolResult;

  const text = result.content[0]?.text ?? '';

  if (result.isError) throw new Error(`${name}: ${text}`);

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
