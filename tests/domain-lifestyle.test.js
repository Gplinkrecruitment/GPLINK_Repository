import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
const { __testUtils } = require('../server.js');

const {
  collectDomainResidentialSearchListings,
  normalizeDomainListing
} = __testUtils;

describe('Domain lifestyle listing normalization', () => {
  it('maps Domain residential search rows into listing cards without a secondary detail lookup', () => {
    const record = {
      type: 'PropertyListing',
      listing: {
        listingType: 'Sale',
        id: 2013958589,
        priceDetails: {
          displayPrice: 'Contact Agent'
        },
        media: [
          {
            category: 'Image',
            url: 'https://bucket-api.domain.com.au/v1/bucket/image/2013958589_1_0_171026_043335-w4500-h3000'
          }
        ],
        propertyDetails: {
          propertyType: 'House',
          bathrooms: 2,
          bedrooms: 3,
          carspaces: 1,
          streetNumber: '177',
          street: 'Australia Street',
          suburb: 'NEWTOWN',
          state: 'NSW',
          postcode: '2042',
          displayableAddress: '177 Australia Street, Newtown',
          latitude: -33.8938522,
          longitude: 151.176926
        },
        headline: 'Classic terrace enhanced for modern urban living',
        summaryDescription: '<b>Classic terrace enhanced for modern urban living</b><br />Freshly renovated and ready to inspect.',
        listingSlug: '177-australia-street-newtown-nsw-2042-2013958589'
      }
    };

    const listing = normalizeDomainListing(record, { lat: -33.8905, lng: 151.1725 }, 'buy');

    expect(listing).toBeTruthy();
    expect(listing.address).toBe('177 Australia Street, Newtown');
    expect(listing.title).toBe('Classic terrace enhanced for modern urban living');
    expect(listing.summary).toContain('Freshly renovated and ready to inspect.');
    expect(listing.summary).not.toContain('<');
    expect(listing.sourceUrl).toBe('https://www.domain.com.au/177-australia-street-newtown-nsw-2042-2013958589');
    expect(listing.imageUrl).toBe('https://bucket-api.domain.com.au/v1/bucket/image/2013958589_1_0_171026_043335-w4500-h3000');
    expect(listing.bedrooms).toBe(3);
    expect(listing.bathrooms).toBe(2);
    expect(listing.carSpaces).toBe(1);
    expect(listing.propertyType).toBe('House');
    expect(listing.lat).toBeCloseTo(-33.8938522, 6);
    expect(listing.lng).toBeCloseTo(151.176926, 6);
    expect(listing.distanceKm).toBeGreaterThan(0);
  });

  it('collects nested project child listings from Domain search payloads', () => {
    const response = {
      searchResults: [
        {
          type: 'Project',
          listings: [
            {
              type: 'PropertyListing',
              listing: {
                id: 12345,
                priceDetails: {
                  displayPrice: '$1,000/wk'
                },
                media: [
                  {
                    category: 'Image',
                    url: 'https://bucket-api.domain.com.au/v1/bucket/image/w89-h60-12345_1_propertyphoto'
                  }
                ],
                propertyDetails: {
                  propertyType: 'House',
                  bathrooms: 1,
                  bedrooms: 2,
                  carspaces: 1,
                  displayableAddress: '1 Test Street, Newtown',
                  suburb: 'NEWTOWN',
                  state: 'NSW',
                  latitude: -33.89,
                  longitude: 151.17
                },
                listingSlug: '1-test-street-newtown-nsw-2042-12345'
              }
            }
          ]
        }
      ]
    };

    const rows = collectDomainResidentialSearchListings(response);
    const listing = normalizeDomainListing(rows[0], { lat: -33.891, lng: 151.171 }, 'rent');

    expect(rows).toHaveLength(1);
    expect(listing).toBeTruthy();
    expect(listing.address).toBe('1 Test Street, Newtown');
    expect(listing.sourceUrl).toBe('https://www.domain.com.au/1-test-street-newtown-nsw-2042-12345');
    expect(listing.priceValue).toBe(1000);
  });
});
