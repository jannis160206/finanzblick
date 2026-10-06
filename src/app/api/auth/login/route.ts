import { credentialsHandler } from "@/lib/server/handlers";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return credentialsHandler(request, "login");
}
