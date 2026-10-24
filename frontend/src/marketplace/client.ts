export type Listing = {
  id: number;
  name: string;
  category: string;
  description: string;
  imageUrl: string | null;
  condition: string;
  dailyFee: string;
  deposit: string;
  location: string;
  pickupDetails: string;
  ownerName: string;
  active?: number;
};
export type Booking = {
  id: number;
  listingId: number;
  name: string;
  startTime: string;
  endTime: string;
  status: "REQUESTED" | "APPROVED" | "REJECTED";
  onchainRentalId: string | null;
  transactionHash: string | null;
  chainId?: number | null;
  onchainVerificationStatus?: "VERIFIED" | "UNVERIFIED" | null;
  onchainRentalStatus?: "CREATED" | "FUNDED" | "ACTIVE" | "RETURNED" | "REFUNDED" | "DISPUTED" | "RESOLVED" | null;
  onchainStateCheckedAt?: string | null;
  renterWalletAddress?: string | null;
  dailyFee?: string;
  deposit?: string;
};

async function json<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "request_failed");
  return body as T;
}

export async function fetchListings(query = "", category = ""): Promise<Listing[]> {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (category) params.set("category", category);
  const result = await json<{ listings: Listing[] }>(await fetch(`/api/listings?${params}`, { credentials: "include" }));
  return result.listings;
}

export async function createListing(input: Record<string, string>): Promise<number> {
  const result = await json<{ listingId: number }>(await fetch("/api/listings", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }));
  return result.listingId;
}

export async function updateListing(listingId: number, input: Partial<Pick<Listing, "name" | "category" | "description" | "imageUrl" | "condition" | "dailyFee" | "deposit" | "location" | "pickupDetails">> & { active: boolean }): Promise<void> {
  await json(await fetch(`/api/listings/${listingId}`, {
    method: "PUT",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }));
}

export async function fetchBookings(): Promise<Booking[]> {
  const result = await json<{ bookings: Booking[] }>(await fetch("/api/bookings", { credentials: "include" }));
  return result.bookings;
}

export async function createBooking(listingId: number, startTime: string, endTime: string): Promise<{ bookingId: number; status: string }> {
  return json(await fetch("/api/bookings", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ listingId, startTime, endTime }),
  }));
}

export async function updateBookingStatus(bookingId: number, status: "APPROVED" | "REJECTED"): Promise<void> {
  await json(await fetch(`/api/bookings/${bookingId}/status`, {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  }));
}

export async function recordOnchainRental(bookingId: number, rentalId: string, transactionHash: string, chainId: number): Promise<void> {
  await json(await fetch(`/api/bookings/${bookingId}/onchain`, {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rentalId, transactionHash, chainId }),
  }));
}

export async function reconcileOnchainRental(bookingId: number): Promise<{ status: string; verified: boolean }> {
  return json(await fetch(`/api/bookings/${bookingId}/onchain/reconcile`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
  }));
}

export async function fetchMyListings(): Promise<Listing[]> {
  const result = await json<{ listings: Listing[] }>(await fetch("/api/my/listings", { credentials: "include" }));
  return result.listings;
}
