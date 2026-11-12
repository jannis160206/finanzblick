import { afterEach, describe, expect, it } from "vitest";
import { knowledgeCorpus } from "./corpus";
import { chunkHash, confidentHit, fuseHits, keywordTerms, knowledgeEvidence, localKnowledgeAnswer, MAX_KNOWLEDGE_HITS, VECTOR_MATCH } from "./query";
import { resetKnowledgeIndex, searchKnowledge } from "./search";
import stored from "./vectors.json";
import { vectorFromBase64, type StoredVectors } from "./vectors";

const vectors = stored as StoredVectors;
const byId = new Map(knowledgeCorpus.map((chunk) => [chunk.id, chunk]));
// A question "about" a chunk: its own stored vector, so the vector search is deterministic without the model.
const like = (id: string) => async () => [...vectorFromBase64(vectors.entries[id].vector)];

afterEach(() => resetKnowledgeIndex());

describe("finance knowledge corpus", () => {
  it("has unique ids, short texts and an up-to-date vector for every chunk (npm run knowledge:index)", () => {
    expect(new Set(knowledgeCorpus.map((chunk) => chunk.id)).size).toBe(knowledgeCorpus.length);
    for (const chunk of knowledgeCorpus) {
      expect(chunk.text.length, chunk.id).toBeLessThanOrEqual(480);
      expect(vectors.entries[chunk.id]?.hash, chunk.id).toBe(chunkHash(chunk));
    }
  });
});

describe("hybrid knowledge search", () => {
  it("fuses vector and keyword ranks and keeps at most three close hits", async () => {
    const result = await searchKnowledge("Wie groß sollte meine Reserve für Notfälle sein?", { embed: like("notgroschen") });
    expect(result.mode).toBe("hybrid");
    expect(result.hits[0]).toMatchObject({ id: "notgroschen", keyword: 1 });
    expect(result.hits[0].distance).toBeLessThan(0.01);
    expect(result.hits.length).toBeLessThanOrEqual(MAX_KNOWLEDGE_HITS);
    expect(result.hits.every((hit) => (hit.distance ?? 1) <= VECTOR_MATCH + 0.03)).toBe(true);
  });

  it("falls back to keywords on title and search words when the embedding model is unavailable", async () => {
    const offline = await searchKnowledge("Was ist die Pendlerpauschale?", { embed: async () => { throw new Error("offline"); } });
    expect(offline.mode).toBe("keyword");
    expect(offline.hits[0]).toMatchObject({ id: "pendlerpauschale", keyword: 1 });
    // German compounds: "Frist" is found inside "Kündigungsfrist".
    expect((await searchKnowledge("Wie lange ist die Frist beim Handyvertrag?", { embed: async () => { throw new Error("offline"); } })).hits.map((hit) => hit.id))
      .toContain("handy-internet");
    expect((await searchKnowledge("Wie wird das Wetter?", { embed: async () => { throw new Error("offline"); } })).hits).toEqual([]);
  });

  it("uses keywords only when the stored vectors belong to another model", async () => {
    resetKnowledgeIndex({ ...vectors, model: "anderes-modell" });
    expect((await searchKnowledge("Was ist ein ETF?")).mode).toBe("keyword");
  });
});

describe("knowledge helpers", () => {
  it("extracts search words without filler words and with light stemming", () => {
    expect(keywordTerms("Was ist eigentlich ein ETF?")).toEqual(["etf"]);
    expect(keywordTerms("Wie viel sollte man als Notgroschen haben?")).toEqual(["notgrosch"]);
    expect(keywordTerms("Wann kann ich meine Versicherungen kündigen?")).toEqual(["versicher", "kündig"]);
  });

  it("drops far hits and answers directly only when the best hit is clearly close", () => {
    const hits = fuseHits(byId, ["etf", "sparplan"], [{ id: "etf", distance: 0.2 }, { id: "sparplan", distance: 0.3 }, { id: "gold", distance: 0.5 }]);
    expect(hits.map((hit) => hit.id)).toEqual(["etf", "sparplan"]);
    expect(confidentHit(hits, "hybrid")?.id).toBe("etf");
    expect(confidentHit(fuseHits(byId, [], [{ id: "gold", distance: 0.52 }]), "hybrid")).toBeUndefined();
    expect(fuseHits(byId, ["gold"], [{ id: "gold", distance: 0.7 }])).toEqual([]);
  });

  it("keeps the evidence short and the direct answer honest about its source", () => {
    const hits = fuseHits(byId, ["notgroschen", "tagesgeld-festgeld", "sparquote"], [
      { id: "notgroschen", distance: 0.2 }, { id: "tagesgeld-festgeld", distance: 0.3 }, { id: "sparquote", distance: 0.32 }]);
    const evidence = knowledgeEvidence(hits)!;
    expect(evidence.length).toBeLessThanOrEqual(900);
    expect(evidence).toMatch(/^Allgemeines Finanzwissen \(keine Daten des Nutzers\):\n- Notgroschen: /);
    const answer = localKnowledgeAnswer(hits[0], hits);
    expect(answer.text).toBe(byId.get("notgroschen")!.text);
    expect(answer.card).toMatchObject({ title: "Notgroschen", note: expect.stringMatching(/ohne Internet/) });
  });
});
