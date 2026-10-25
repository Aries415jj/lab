import { useEffect, useRef, useState } from "react";
import { Lab_warehouseitemsService } from "@/generated/services/Lab_warehouseitemsService";
import { OpenFoodFactsService } from "@/generated/services/OpenFoodFactsService";
import type { Product } from "@/generated/models/OpenFoodFactsModel";
import { getClient } from "@microsoft/power-apps/data";
import { dataSourcesInfo } from "../../.power/schemas/appschemas/dataSourcesInfo";
import {
  Button,
  Card,
  Caption1,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Spinner,
  Subtitle2,
  Body1,
} from "@fluentui/react-components";
import { BarcodeScannerRegular } from "@fluentui/react-icons";
import { TextField, usePcfContext } from "@talxis/base-controls";
import { useBarcodeCamera } from "@/hooks/UseBarcodeCamera";
import { useToast } from "@/hooks/use-toast";
import { toBytes, bytesToDataUrl } from "@/utils/Binary";
import { eanError } from "@/utils/Barcode";
import { ensureProductRecord } from "@/utils/BarcodeLookup";
import { servicePayload, serviceResult } from "@/utils/ServicePayload";
import { useStyles } from "@/styles/BarcodeScanDialog.styles";

type BarcodeScanDialogProps = {
  itemId: string;
  /** The item's current lab_productid_value, if it's already linked to a Product. */
  currentProductId?: string;
  onLinked: () => void;
};

// A camera scan and a manually-typed EAN both end up going through the same handleEan path -
// there's exactly one place that decides what a barcode means. The manual input is also the
// only way to drive this in CI/Playwright, which has no camera: see 11-tests-ui for how the
// test hook types into the scan-ean-input and clicks scan-lookup-button directly, skipping
// the camera.
export default function BarcodeScanDialog({ itemId, currentProductId, onLinked }: BarcodeScanDialogProps) {
  const styles = useStyles();
  const toast = useToast();
  const context = usePcfContext();
  const [open, setOpen] = useState(false);
  const [ean, setEan] = useState("");
  const [productBarcode, setProductBarcode] = useState<string | null>(null);
  const eanMessage = eanError(ean);
  const [looking, setLooking] = useState(false);
  const [linking, setLinking] = useState(false);
  const [product, setProduct] = useState<Product | null>(null);
  const [imgError, setImgError] = useState(false);
  const [imageLoading, setImageLoading] = useState(false);
  // The image proxied through the connector for the barcode just looked up: a data: URI for
  // preview, and the bytes it came from so linkProduct() can upload them without re-fetching.
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const [imageBytes, setImageBytes] = useState<Uint8Array | null>(null);
  // A callback ref, not useRef: the decode effect must not start before the <video> is
  // actually mounted, and state (unlike a ref) retriggers the effect once it is.
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  // A camera decode and a manual lookup can resolve in either order - once one of them has
  // already produced a product, a late/stray camera decode (e.g. a misread off a bad frame)
  // must not silently overwrite it.
  const productFoundRef = useRef(false);
  const lookupRequestRef = useRef(0);
  const cameraStatus = useBarcodeCamera(videoEl, open, (text) => {
    if (productFoundRef.current) return;
    setEan(text);
    void handleEan(text);
  });

  // A fresh scan starts every time the dialog opens
  useEffect(() => {
    if (open) productFoundRef.current = false;
  }, [open]);

  const handleEan = async (barcode: string) => {
    if (!barcode || eanError(barcode)) return;
    const requestId = ++lookupRequestRef.current;
    setLooking(true);
    setImageLoading(false);
    setProduct(null);
    setProductBarcode(null);
    setImgError(false);
    setPreviewImageUrl(null);
    setImageBytes(null);
    try {
      const result = await OpenFoodFactsService.GetProductByBarcode(barcode);
      if (requestId !== lookupRequestRef.current) return;
      if (!result.success || !result.data) {
        const message = result.error?.message;
        toast.error(
          message && !/404|not found/i.test(message)
            ? `Lookup failed: ${message}`
            : "No product found for this barcode"
        );
        return;
      }
      setProduct(result.data);
      setProductBarcode(barcode);
      productFoundRef.current = true;
      // The barcode lookup itself is what "Look Up" promises - stop its spinner here and let
      // the (much slower, since it redirects through a different host) image fetch run with
      // its own loading state, so the button doesn't look stuck while the photo comes in.
      setLooking(false);

      if (result.data.imageUrl) {
        // A code app's CSP can block an <img> pointed at an external URL - proxy the bytes
        // through the connector instead, then render them from a data: URI.
        setImageLoading(true);
        try {
          const bytes = await fetchProductImageBytes(result.data.imageUrl);
          if (requestId !== lookupRequestRef.current) return;
          if (bytes) {
            setImageBytes(bytes);
            setPreviewImageUrl(bytesToDataUrl(bytes, "image/jpeg"));
          } else {
            setImgError(true);
          }
        } catch {
          if (requestId !== lookupRequestRef.current) return;
          // The image is a nice-to-have on top of the product info already surfaced - fall
          // back to the "no image" state rather than failing the whole lookup over it.
          setImgError(true);
        } finally {
          if (requestId === lookupRequestRef.current) setImageLoading(false);
        }
      }
    } catch (err) {
      if (requestId === lookupRequestRef.current) {
        toast.error("Lookup failed: " + String(err));
      }
    } finally {
      if (requestId === lookupRequestRef.current) setLooking(false);
    }
  };

  const fetchProductImageBytes = async (imageUrl: string): Promise<Uint8Array | null> => {
    const result = await OpenFoodFactsService.GetProductImage(imageUrl);
    if (!result.success || !result.data) return null;
    return toBytes(result.data);
  };

  const linkProduct = async () => {
    if (!product || !productBarcode) return;
    setLinking(true);
    try {
      const productId = await ensureProductRecord(productBarcode, product);

      if (!productId) {
        toast.error("Could not resolve a Product record to link");
        return;
      }

      await serviceResult(Lab_warehouseitemsService.update(itemId, servicePayload({
        "lab_productid@odata.bind": `/lab_products(${productId})`,
        // So the Receive screen finds this item by the same barcode next time
        lab_barcode: productBarcode,
      })));

      let imageSaveError: string | undefined;
      if (imageBytes) {
        try {
          // The generated services cover create/update/get but emit nothing for file columns -
          // the runtime client does, and it takes the bytes directly. It reports failures as
          // { success: false } rather than throwing, so the result has to be checked.
          const upload = await getClient(dataSourcesInfo).uploadFileToRecord(
            "lab_products",
            productId,
            "lab_productimage",
            `${productBarcode}.jpg`,
            imageBytes
          );
          if (!upload.success) {
            throw upload.error ?? new Error("upload rejected");
          }
        } catch (err) {
          imageSaveError = String(err);
        }
      } else if (product.imageUrl) {
        imageSaveError = "The product image could not be loaded";
      }

      if (imageSaveError) {
        toast.error("Product linked, but its image failed to save: " + imageSaveError);
      }
      toast.success("Product linked to item");
      onLinked();
      resetAndClose();
    } catch (err) {
      toast.error("Failed to link product: " + String(err));
    } finally {
      setLinking(false);
    }
  };

  const resetAndClose = () => {
    lookupRequestRef.current++;
    setOpen(false);
    setEan("");
    setProduct(null);
    setProductBarcode(null);
    setPreviewImageUrl(null);
    setImageBytes(null);
    setImgError(false);
    setImageLoading(false);
    setLooking(false);
    productFoundRef.current = false;
  };

  const updateEan = (value: string) => {
    setEan(value);
    if (value === productBarcode) return;
    lookupRequestRef.current++;
    setLooking(false);
    setImageLoading(false);
    setProduct(null);
    setProductBarcode(null);
    setImgError(false);
    setPreviewImageUrl(null);
    setImageBytes(null);
  };

  return (
    <>
      <Button
        appearance="outline"
        size="small"
        icon={<BarcodeScannerRegular />}
        data-testid="scan-barcode-button"
        onClick={() => setOpen(true)}
      >
        {currentProductId ? "Rescan Barcode" : "Scan Barcode"}
      </Button>

      <Dialog open={open} onOpenChange={(_, data) => (data.open ? setOpen(true) : resetAndClose())}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Scan Product Barcode</DialogTitle>

            <DialogContent className={styles.content}>
              <video
                ref={setVideoEl}
                className={styles.video}
                muted
                autoPlay
                playsInline
              />
              {cameraStatus === "starting" && (
                <Body1 className={styles.muted}>Starting the camera...</Body1>
              )}
              {cameraStatus === "unavailable" && (
                <Body1 className={styles.muted}>Camera unavailable. Type the barcode instead.</Body1>
              )}

              {/* The TextField only underlines its error in red; the message itself shows on the Field */}
              <Field
                label="EAN / UPC barcode"
                validationState={eanMessage ? "error" : "none"}
                validationMessage={eanMessage}
              >
                <div className={styles.eanRow}>
                  <div className={styles.eanInput}>
                    <TextField
                      context={context}
                      parameters={{
                        value: { raw: ean, type: "SingleLine.Text", error: !!eanMessage, errorMessage: eanMessage },
                        Placeholder: { raw: "e.g. 3017620422003" },
                      }}
                      onNotifyOutputChanged={(outputs) => setEan(outputs.value ?? "")}
                      // The control reports its value on blur; mirror keystrokes too, so Look Up
                      // enables while the barcode is still being typed
                      onOverrideComponentProps={(props) => ({
                        ...props,
                        id: "scanEan",
                        "data-testid": "scan-ean-input",
                        onChange: (event, value) => {
                          props.onChange?.(event, value);
                          updateEan(value ?? "");
                        },
                      })}
                    />
                  </div>
                  <Button
                    type="button"
                    appearance="primary"
                    data-testid="scan-lookup-button"
                    disabled={!ean || !!eanMessage || looking}
                    onClick={() => void handleEan(ean)}
                  >
                    {looking ? <Spinner size="tiny" /> : "Look Up"}
                  </Button>
                </div>
              </Field>

              {product && (
                <Card className={styles.product}>
                  {imageLoading && (
                    <div className={styles.imagePlaceholder}>
                      <Spinner size="tiny" />
                    </div>
                  )}
                  {previewImageUrl && !imgError && (
                    <img
                      src={previewImageUrl}
                      alt={product.name ?? ean}
                      className={styles.image}
                      onError={() => setImgError(true)}
                    />
                  )}
                  <div className={styles.productText}>
                    <Subtitle2 data-testid="scan-product-name">
                      {product.name ?? "Unknown product"}
                    </Subtitle2>
                    <Caption1 className={styles.muted}>
                      {[product.brand, product.quantity].filter(Boolean).join(" · ")}
                    </Caption1>
                    {imgError && product.imageUrl && (
                      <Caption1 className={styles.muted}>Image unavailable; you can still link this product.</Caption1>
                    )}
                  </div>
                </Card>
              )}
            </DialogContent>

            <DialogActions>
              <Button type="button" appearance="secondary" onClick={resetAndClose}>
                Cancel
              </Button>
              <Button
                type="button"
                appearance="primary"
                data-testid="scan-link-button"
                disabled={!product || !productBarcode || looking || imageLoading || linking}
                onClick={() => void linkProduct()}
              >
                {linking ? <Spinner size="tiny" /> : "Link to Item"}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}
