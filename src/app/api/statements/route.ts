import { cancelStatement, uploadStatement } from "@/lib/automation/handlers";

export const runtime = "nodejs";
export const POST = uploadStatement;
export const DELETE = cancelStatement;
