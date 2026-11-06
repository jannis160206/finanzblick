import { z } from "zod";
import { classifyReceiptItemsWithAi } from "@/lib/ai/receipt-items";
import { handleAiPost } from "@/lib/ai/route-support";

export const runtime = "nodejs";

const requestSchema = z.object({
  names: z.array(z.string().trim().min(2).max(80)).min(1).max(40),
}).strict();

// Categories for receipt lines the keyword list does not know; amounts never leave the browser.
export async function POST(request: Request): Promise<Response> {
  return handleAiPost(request, "receipt-items", requestSchema, 8 * 1024, async (input, signal) => ({
    categories: await classifyReceiptItemsWithAi(input.names, { signal }),
  }));
}
