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

describe("offer kinds", () => {
  /**
   * Shaped from the real feed entry that failed to claim on 26/08/2026: an ADD_ON for Albion
   * Online, whose only offerMapping is a `pageType: "offer"` rather than a productHome.
   */
  const addOn = {
    data: {
      Catalog: {
        searchStore: {
          elements: [
            {
              title: "Epic Mage Bundle",
              offerType: "ADD_ON",
              productSlug: null,
              urlSlug: "epic-mage-bundle",
              offerMappings: [
                { pageSlug: "albion-online-epic-mage-bundle-2ceb19", pageType: "offer" },
              ],
              catalogNs: { mappings: [{ pageSlug: "albion-online-7eb24d", pageType: "productHome" }] },
              promotions: {
                promotionalOffers: [
                  {
                    promotionalOffers: [
                      {
                        startDate: "2026-08-20T15:00:00.000Z",
                        endDate: "2026-09-03T15:00:00.000Z",
                        discountSetting: { discountPercentage: 0 },
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      },
    },
  };

  const NOW = Date.parse("2026-08-26T00:00:00.000Z");

  it("keeps the offer type, so a failure can say what kind of thing it was", () => {
    // Without this every add-on failure reads like the same unexplained checkout bug.
    expect(parseFreeGamesResponse(addOn, NOW)[0]).toMatchObject({
      title: "Epic Mage Bundle",
      kind: "ADD_ON",
    });
  });

  it("prefers the offer's own mapping over the parent product's", () => {
    // catalogNs points at Albion Online itself; claiming that instead of the add-on would be a
    // different thing entirely, and would silently look like it worked.
    expect(parseFreeGamesResponse(addOn, NOW)[0]!.url).toContain(
      "albion-online-epic-mage-bundle-2ceb19",
    );
  });

  it("leaves kind unset when the feed omits it", () => {
    const noType = JSON.parse(JSON.stringify(addOn));
    delete noType.data.Catalog.searchStore.elements[0].offerType;
    expect(parseFreeGamesResponse(noType, NOW)[0]!.kind).toBeUndefined();
  });
});
