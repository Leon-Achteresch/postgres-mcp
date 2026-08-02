export type ToolResult = { content: [{ type: "text"; text: string }] };

export function body(result: ToolResult): string {
  return result.content[0].text;
}

export function parseJson<T = unknown>(result: ToolResult | string): T {
  const text = typeof result === "string" ? result : body(result);
  return JSON.parse(text) as T;
}

export function assertSuccess(result: ToolResult, label: string): string {
  const text = body(result);
  if (text.startsWith("Error:")) throw new Error(`${label}: ${text}`);
  return text;
}

export function assertError(result: ToolResult, label: string): string {
  const text = body(result);
  if (!text.startsWith("Error:")) throw new Error(`${label}: expected error, got ${text.slice(0, 200)}`);
  return text;
}

export function hasExtensionMessage(text: string, name: string): boolean {
  return text.toLowerCase().includes(name.toLowerCase());
}
