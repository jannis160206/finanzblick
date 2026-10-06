import { logoutHandler } from "@/lib/server/handlers";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return logoutHandler(request);
}
