import { Lab_productsService } from "@/generated/services/Lab_productsService";
import { OpenFoodFactsService } from "@/generated/services/OpenFoodFactsService";
import type { Product } from "@/generated/models/OpenFoodFactsModel";
import { servicePayload, serviceResult } from "@/utils/ServicePayload";

/** What is known about a barcode from an outside catalog. */
export type BarcodeProduct = {
  /** The product's name, to prefill a new item with. */
  name?: string;
  /** Creates (or finds) the catalog record for the barcode and returns its id, to link a new item to. */
  ensureProductId?: () => Promise<string | undefined>;
};

// Finds the Product record for a barcode, creating it from the catalog data when there is none yet.
// No alternate key on EAN (see .lab-scripts/scaffold/15-product-table.ps1) - a plain filter-then-create
// instead of an upsert, so scanning the same barcode twice reuses the existing Product record rather
// than duplicating it.
export async function ensureProductRecord(ean: string, product: Product): Promise<string | undefined> {
  const existing = await serviceResult(Lab_productsService.getAll({
    select: ["lab_productid"],
    filter: `lab_ean eq '${ean}'`,
    top: 1,
  }));
  let productId = existing.data?.[0]?.lab_productid;

  if (!productId) {
    // createRecordAsync's response shape for the new record's id isn't reliable across hosts -
    // re-query by the same EAN filter used above instead of trusting the create call's own return value.
    await serviceResult(Lab_productsService.create(servicePayload({
      lab_name: product.name || ean,
      lab_ean: ean,
      lab_brand: product.brand,
      lab_quantity: product.quantity,
      lab_imageurl: product.imageUrl,
      lab_lastsyncedon: new Date().toISOString(),
    })));

    const created = await serviceResult(Lab_productsService.getAll({
      select: ["lab_productid"],
      filter: `lab_ean eq '${ean}'`,
      top: 1,
    }));
    productId = created.data?.[0]?.lab_productid;
  }

  return productId;
}

// Asks the Open Food Facts connector about a barcode, for the Receive screen: a product it knows
// prefills a new item's name and brings the Product record to link the item to. This replaces the
// do-nothing default the phone screens ship with (utils/barcode-lookup.ts).
export async function lookupBarcode(ean: string): Promise<BarcodeProduct | null> {
  const result = await OpenFoodFactsService.GetProductByBarcode(ean);
  if (!result.success || !result.data) return null;
  const product = result.data;
  return { name: product.name, ensureProductId: () => ensureProductRecord(ean, product) };
}

