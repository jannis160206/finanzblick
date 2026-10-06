import { sessionHandler } from "@/lib/server/handlers";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return sessionHandler(request);
}
