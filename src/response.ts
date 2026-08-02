export function text(data: unknown): { content: [{ type: "text"; text: string }] } {
  const body = typeof data === "string" ? data : JSON.stringify(data);
  return { content: [{ type: "text", text: body }] };
}

export function rows(
  data: unknown[],
  meta?: { truncated?: number; total?: number }
): { content: [{ type: "text"; text: string }] } {
  if (!meta) return text(data);
  return text({ rows: data, ...meta });
}

export function error(message: string): { content: [{ type: "text"; text: string }] } {
  return text(`Error: ${message}`);
}
