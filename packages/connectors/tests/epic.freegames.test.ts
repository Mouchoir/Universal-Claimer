import { describe, expect, it } from "vitest";
import { parseFreeGamesResponse } from "../src/epic/driver.js";

const NOW = Date.parse("2026-07-24T12:00:00Z");
const past = new Date(NOW - 86_400_000).toISOString();
const soon = new Date(NOW + 86_400_000).toISOString();
const later = new Date(NOW + 7 * 86_400_000).toISOString();

function element(over: Record<string, unknown>) {
  return {
    title: "Untitled",
    offerMappings: [{ pageSlug: "slug", pageType: "productHome" }],
    ...over,
  };
}

function feed(elements: unknown[]) {
  return { data: { Catalog: { searchStore: { elements } } } };
}

const activeFreeOffer = {
  promotionalOffers: [
    { promotionalOffers: [{ startDate: past, endDate: soon, discountSetting: { discountPercentage: 0 } }] },
  ],
};

describe("parseFreeGamesResponse", () => {
  it("returns games that are free right now with the productHome slug URL", () => {
    const json = feed([
      element({
        title: "Foretales",
        offerMappings: [{ pageSlug: "foretales-d6c5bd", pageType: "productHome" }],
        promotions: activeFreeOffer,
      }),
    ]);
    expect(parseFreeGamesResponse(json, NOW)).toEqual([
      { title: "Foretales", url: "https://store.epicgames.com/en-US/p/foretales-d6c5bd" },
    ]);
  });

  it("excludes upcoming promotions (window in the future)", () => {
    const json = feed([
      element({
        title: "OTXO",
        promotions: {
          promotionalOffers: [
            { promotionalOffers: [{ startDate: soon, endDate: later, discountSetting: { discountPercentage: 0 } }] },
          ],
        },
      }),
    ]);
    expect(parseFreeGamesResponse(json, NOW)).toEqual([]);
  });

  it("excludes non-free discounts and elements without promotions", () => {
    const json = feed([
      element({
        title: "Half off",
        promotions: {
          promotionalOffers: [
            { promotionalOffers: [{ startDate: past, endDate: soon, discountSetting: { discountPercentage: 50 } }] },
          ],
        },
      }),
      element({ title: "No promo", promotions: null }),
    ]);
    expect(parseFreeGamesResponse(json, NOW)).toEqual([]);
  });

  it("falls back to catalogNs mappings then productSlug for the URL", () => {
    const json = feed([
      element({ title: "Via ns", offerMappings: null, catalogNs: { mappings: [{ pageSlug: "ns-slug", pageType: "productHome" }] }, promotions: activeFreeOffer }),
      element({ title: "Via productSlug", offerMappings: null, catalogNs: null, productSlug: "prod-slug", promotions: activeFreeOffer }),
    ]);
    expect(parseFreeGamesResponse(json, NOW)).toEqual([
      { title: "Via ns", url: "https://store.epicgames.com/en-US/p/ns-slug" },
      { title: "Via productSlug", url: "https://store.epicgames.com/en-US/p/prod-slug" },
    ]);
  });

  it("de-duplicates by slug and tolerates an empty/garbage feed", () => {
    const dup = element({ title: "Dup", promotions: activeFreeOffer });
    expect(parseFreeGamesResponse(feed([dup, dup]), NOW)).toHaveLength(1);
    expect(parseFreeGamesResponse({}, NOW)).toEqual([]);
    expect(parseFreeGamesResponse(null, NOW)).toEqual([]);
  });
});
