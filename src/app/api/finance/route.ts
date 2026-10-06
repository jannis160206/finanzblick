import { financeHandler } from "@/lib/server/handlers";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return financeHandler(request);
}

export async function PUT(request: Request): Promise<Response> {
  return financeHandler(request);
}
