import { useState, type ChangeEvent, type FormEvent } from "react";
import { createListing, updateListing, type Listing } from "../marketplace/client";

type ListingDraft = {
  serialId: string;
  name: string;
  category: string;
  description: string;
  imageUrl: string;
  condition: string;
  dailyFee: string;
  deposit: string;
  location: string;
  pickupDetails: string;
};

const initialDraft: ListingDraft = {
  serialId: "",
  name: "",
  category: "Sound",
  description: "",
  imageUrl: "",
  condition: "",
  dailyFee: "",
  deposit: "",
  location: "",
  pickupDetails: "",
};

function imageErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : "invalid_image";
  if (code === "invalid_image_type") return "Use a PNG, JPG, or WebP image.";
  if (code === "image_too_large") return "Choose an image smaller than 5 MB.";
  if (code === "image_processing_failed") return "The image could not be processed. Try another file.";
  return "The image could not be uploaded.";
}

async function prepareListingImage(file: File): Promise<string> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("invalid_image_type");
  if (file.size > 5 * 1024 * 1024) throw new Error("image_too_large");
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("image_processing_failed"));
      element.src = objectUrl;
    });
    const maxDimension = 1200;
    const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("image_processing_failed");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.78);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function categories() {
  return <><option>Sound</option><option>Projection</option><option>Capture</option><option>Lighting</option><option>Accessories</option></>;
}

function ImageField({ value, onChange, onMessage }: { value: string; onChange: (value: string) => void; onMessage: (message: string) => void }) {
  async function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    onMessage("");
    try {
      onChange(await prepareListingImage(file));
    } catch (error) {
      onMessage(imageErrorMessage(error));
    } finally {
      event.target.value = "";
    }
  }
  return <label className="full-width listing-image-field">Item image (optional) <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void handleChange(event)} /><small>Upload a clear image of the actual equipment. If you skip it, renters will see an image-pending placeholder.</small>{value && <img className="listing-image-preview" src={value} alt="Equipment preview" />}</label>;
}

function listingMessage(code: string): string {
  if (code === "authentication_required") return "Sign in before publishing a listing.";
  if (code === "owner_role_required") return "Choose the owner workspace before publishing.";
  if (code === "invalid_serial_id") return "Enter a serial ID with 4–64 letters, numbers, dots, dashes, or underscores.";
  if (code === "serial_id_already_registered") return "That serial ID is already registered to another listing.";
  if (code === "invalid_listing") return "Add valid values for every field, including positive ETH amounts.";
  return "Listing could not be saved. Try again.";
}

export function ListingForm({ onComplete }: { onComplete: () => void }) {
  const [values, setValues] = useState<ListingDraft>(initialDraft);
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);
  const set = (field: keyof ListingDraft, value: string) => setValues((current) => ({ ...current, [field]: value }));
  async function submit(event: FormEvent) {
    event.preventDefault();
    setWorking(true);
    setMessage("");
    try {
      await createListing(values);
      setMessage("Listing published successfully. Renters can now see the validated serial ID and item image.");
      onComplete();
    } catch (error) {
      setMessage(listingMessage(error instanceof Error ? error.message : "request_failed"));
    } finally {
      setWorking(false);
    }
  }
  return <section className="content-panel listing-form"><h2>Add owner-verified equipment</h2><p className="auth-intro">Owners must provide a unique serial ID. The image and validation status are shown to renters in the marketplace.</p><form className="form-grid" onSubmit={submit}><label>Serial ID<input required pattern="[A-Za-z0-9][A-Za-z0-9._-]{3,63}" placeholder="e.g. CAM-2026-001" value={values.serialId} onChange={(event) => set("serialId", event.target.value)} /><small>Unique identifier used to validate this physical item.</small></label><label>Name<input required value={values.name} onChange={(event) => set("name", event.target.value)} /></label><label>Category<select value={values.category} onChange={(event) => set("category", event.target.value)}>{categories()}</select></label><label className="full-width">Description<textarea required value={values.description} onChange={(event) => set("description", event.target.value)} /></label><label>Condition<input required value={values.condition} onChange={(event) => set("condition", event.target.value)} /></label><ImageField value={values.imageUrl} onChange={(value) => set("imageUrl", value)} onMessage={setMessage} /><label>Daily fee (ETH)<input required inputMode="decimal" value={values.dailyFee} onChange={(event) => set("dailyFee", event.target.value)} /></label><label>Security deposit (ETH)<input required inputMode="decimal" value={values.deposit} onChange={(event) => set("deposit", event.target.value)} /></label><label>Location<input required value={values.location} onChange={(event) => set("location", event.target.value)} /></label><label>Pickup details<input required value={values.pickupDetails} onChange={(event) => set("pickupDetails", event.target.value)} /></label><button className="button-primary" type="submit" disabled={working}>{working ? "Publishing..." : "Publish validated listing"}</button></form>{message && <p className={`message ${message.includes("successfully") ? "success" : "error"}`}>{message}</p>}</section>;
}

export function ListingEditForm({ listing, onCancel, onComplete }: { listing: Listing; onCancel: () => void; onComplete: () => Promise<void> }) {
  const [values, setValues] = useState<ListingDraft & { active: boolean }>({ serialId: listing.serialId || "", name: listing.name, category: listing.category, description: listing.description, imageUrl: listing.imageUrl || "", condition: listing.condition, dailyFee: listing.dailyFee, deposit: listing.deposit, location: listing.location, pickupDetails: listing.pickupDetails, active: Boolean(listing.active) });
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);
  const set = (field: keyof ListingDraft, value: string) => setValues((current) => ({ ...current, [field]: value }));
  async function submit(event: FormEvent) {
    event.preventDefault();
    setWorking(true);
    setMessage("");
    try {
      await updateListing(listing.id, { serialId: values.serialId.trim(), name: values.name.trim(), category: values.category.trim(), description: values.description.trim(), imageUrl: values.imageUrl.trim(), condition: values.condition.trim(), dailyFee: values.dailyFee.trim(), deposit: values.deposit.trim(), location: values.location.trim(), pickupDetails: values.pickupDetails.trim(), active: values.active });
      await onComplete();
    } catch (error) {
      setMessage(listingMessage(error instanceof Error ? error.message : "request_failed"));
    } finally {
      setWorking(false);
    }
  }
  return <section className="content-panel listing-form"><div className="panel-heading"><h2>Edit validated equipment</h2><button className="button-text" type="button" onClick={onCancel}>Cancel</button></div><p className="auth-intro">Keep the serial ID accurate so renters can match the listing to the physical item.</p><form className="form-grid" onSubmit={submit}><label>Serial ID<input required pattern="[A-Za-z0-9][A-Za-z0-9._-]{3,63}" value={values.serialId} onChange={(event) => set("serialId", event.target.value)} /></label><label>Name<input required value={values.name} onChange={(event) => set("name", event.target.value)} /></label><label>Category<select value={values.category} onChange={(event) => set("category", event.target.value)}>{categories()}</select></label><label className="full-width">Description<textarea required value={values.description} onChange={(event) => set("description", event.target.value)} /></label><label>Condition<input required value={values.condition} onChange={(event) => set("condition", event.target.value)} /></label><ImageField value={values.imageUrl} onChange={(value) => set("imageUrl", value)} onMessage={setMessage} /><label>Daily fee (ETH)<input required inputMode="decimal" value={values.dailyFee} onChange={(event) => set("dailyFee", event.target.value)} /></label><label>Security deposit (ETH)<input required inputMode="decimal" value={values.deposit} onChange={(event) => set("deposit", event.target.value)} /></label><label>Location<input required value={values.location} onChange={(event) => set("location", event.target.value)} /></label><label>Pickup details<input required value={values.pickupDetails} onChange={(event) => set("pickupDetails", event.target.value)} /></label><label className="full-width listing-active-field"><input type="checkbox" checked={values.active} onChange={(event) => setValues((current) => ({ ...current, active: event.target.checked }))} /> Visible to renters</label><button className="button-primary" type="submit" disabled={working}>{working ? "Saving..." : "Save listing"}</button></form>{message && <p className={`message ${message.includes("successfully") ? "success" : "error"}`}>{message}</p>}</section>;
}
