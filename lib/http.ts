export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });

export const err = (status: number, message: string) => json({ error: message }, status);

export async function readJson<T>(req: Request): Promise<T> {
  try { return await req.json() as T; }
  catch { throw Object.assign(new Error("Invalid JSON body"), { status: 400 }); }
}
