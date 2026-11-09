import { notFound, redirect } from "next/navigation";

// Each area has its own route (code-split per page); this segment only keeps old bookmarks working.
const moved: Record<string, string> = {
  monate: "/budget?ansicht=jahr",
  plan: "/budget",
  pockets: "/sparen",
  assistent: "/?assistent=1",
};

export default async function MovedPage({
  params,
}: {
  params: Promise<{ view: string }>;
}) {
  const { view } = await params;
  if (Object.hasOwn(moved, view)) redirect(moved[view]);
  notFound();
}
