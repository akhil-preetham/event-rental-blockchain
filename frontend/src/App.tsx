import { useEffect, useState, type FormEvent } from "react";
import type { ReactNode } from "react";
import { Contract, parseEther } from "ethers";
import { connectWallet, restoreWallet } from "./blockchain/wallet";
import { contractAddress, getRentalEscrow, HARDHAT_CHAIN_ID } from "./blockchain/contract";
import { explainWalletError } from "./blockchain/errors";
import { confirmPasswordReset, getSession, loginWithEmail, logout, registerWithEmail, requestPasswordReset, resendVerification, selectRole, signInWithWallet, verifyEmailToken, type AuthUser } from "./auth/client";
import { createListing, fetchBookings, fetchListings, fetchMyListings, recordOnchainRental, updateBookingStatus, updateListing, type Booking, type Listing } from "./marketplace/client";
import { BookingForm } from "./components/BookingForm";
import { CreateRentalForm } from "./components/CreateRentalForm";
import { RentalLookup } from "./components/RentalLookup";
import { RentalActions } from "./components/RentalActions";
import { ListingForm, ListingEditForm } from "./components/ListingForms";
import type { RentalRecord } from "./components/RentalLookup";
import "./styles.css";

type Route = { path: string; id?: string };
type AppRole = "renter" | "owner";
type Equipment = {
  id: string;
  name: string;
  type: string;
  fee: string;
  deposit: string;
  description: string;
  visual: string;
  accent: string;
};

// Inventory is created by owners through the backend; the frontend has no
// hard-coded sample catalogue.
const catalogue: Equipment[] = [];

function currentRoute(): Route {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [pathname] = raw.split("?");
  const parts = pathname.split("/").filter(Boolean);
  if (!parts.length) return { path: "landing" };
  if (parts[0] === "how-it-works" || parts[0] === "trust") return { path: parts[0] };
  if (["dashboard", "disputes", "activity", "settings"].includes(parts[0])) return { path: parts[0] };
  if (parts[0] === "owner") return { path: parts[1] ? `owner/${parts[1]}` : "owner" };
  if (parts[0] === "equipment") return parts[1] ? { path: "equipment/detail", id: parts[1] } : { path: "equipment" };
  if (parts[0] === "my-rentals") return { path: "rentals" };
  if (parts[0] === "rentals" && parts[1]?.split("?")[0] === "create") return { path: "rentals/create" };
  if (parts[0] === "rentals" && (!parts[1] || parts[1] === "all")) return { path: "rentals" };
  if (parts[0] === "rentals" && ["upcoming", "active", "completed"].includes(parts[1] ?? "")) return { path: `rentals/${parts[1]}` };
  if (parts[0] === "rentals" && parts[1]) return { path: "rentals/detail", id: parts[1] };
  return { path: "not-found" };
}

function navigate(path: string) {
  const canonicalPath = path === "my-rentals" || path === "rentals/all" ? "rentals" : path;
  window.location.hash = `/${canonicalPath}`;
}

function protectedRouteFor(route: Route): boolean {
  return ["dashboard", "rentals", "disputes", "activity", "settings"].includes(route.path) || route.path.startsWith("rentals/") || route.path === "owner" || route.path.startsWith("owner/");
}

function explainAuthError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("ACTION_REJECTED") || message.toLowerCase().includes("user rejected")) return "Signature request cancelled. You are not signed in.";
  if (message.includes("invalid_or_expired_challenge")) return "The sign-in challenge expired. Start sign-in again.";
  if (message.includes("origin_not_allowed")) return "This application origin is not allowed by the authentication server.";
  if (message.includes("MetaMask is not installed")) return "Install MetaMask to sign in with your wallet.";
  if (message.includes("wallet_permission_rejected")) return "Wallet access was rejected. Approve the connection in MetaMask or try again.";
  if (message.includes("role_selection_failed") || message.includes("404")) return "Your account signed in, but the backend role service is unavailable. Restart the backend and try again.";
  if (message.includes("wrong network") || message.includes("wrong_network")) return "Switch MetaMask to Hardhat Local before signing in with a wallet.";
  if (message.includes("contract_address_missing")) return "The local escrow contract address is not configured.";
  if (message.includes("contract_unavailable")) return "No RentalEscrow contract was found at the configured address on Hardhat Local.";
  if (message.includes("Failed to fetch")) return "The authentication server is unavailable. Start the backend and try again.";
  return "Wallet sign-in failed. No authenticated session was created.";
}

export default function App() {
  const [route, setRoute] = useState<Route>(currentRoute);
  const [role, setRole] = useState<AppRole | null>(() => {
    const saved = sessionStorage.getItem("eventrent-role");
    return saved === "owner" || saved === "renter" ? saved : null;
  });
  const [contract, setContract] = useState<Contract | null>(null);
  const [address, setAddress] = useState("");
  const [chainId, setChainId] = useState<bigint | null>(null);
  const [walletStatus, setWalletStatus] = useState("Wallet not connected");
  const [authenticatedAddress, setAuthenticatedAddress] = useState("");
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authStatus, setAuthStatus] = useState("Not signed in");
  const [authOpen, setAuthOpen] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [returnDestination, setReturnDestination] = useState<string | null>(null);

  useEffect(() => {
    const handleHashChange = () => setRoute(currentRoute());
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  useEffect(() => {
    void restoreWallet().then(async (wallet) => {
      if (!wallet) return;
      setAddress(wallet.address);
      setChainId(wallet.chainId);
      if (wallet.chainId !== HARDHAT_CHAIN_ID) {
        setWalletStatus("Wallet restored on the wrong network — use Switch Network.");
        return;
      }
      if (!contractAddress) {
        setWalletStatus("Wallet restored, but the escrow contract address is not configured.");
        return;
      }
      if (await wallet.provider.getCode(contractAddress) === "0x") {
        setWalletStatus("Wallet restored, but no escrow contract was found at the configured address.");
        return;
      }
      setContract(getRentalEscrow(wallet.signer));
      setWalletStatus("Local network wallet restored");
    }).catch((error) => setWalletStatus(explainWalletError(error)));
  }, []);

  useEffect(() => {
    if (protectedRouteFor(route) && !authUser) {
      setReturnDestination(window.location.hash.replace(/^#\/?/, "") || "dashboard");
    }
  }, [route, authUser]);

  useEffect(() => {
    if (authUser && role !== "owner" && route.path.startsWith("owner")) navigate("dashboard");
  }, [authUser, role, route]);

  useEffect(() => {
    void getSession().then(async (session) => {
      if (session?.authenticated && session.user) {
        const connectedAccounts = window.ethereum
          ? await window.ethereum.request({ method: "eth_accounts" }) as string[]
          : [];
        const connectedAddress = connectedAccounts[0]?.toLowerCase();
        if (session.user.walletAddress && connectedAddress && session.user.walletAddress.toLowerCase() !== connectedAddress) {
          await logout().catch(() => undefined);
          setAuthStatus("Wallet changed — sign in again to verify the selected account.");
          return;
        }
        const restoredUser = role && !session.user.roles?.includes(role) ? await selectRole(role) : session.user;
        setAuthenticatedAddress(session.user?.walletAddress || "");
        setAuthUser(restoredUser);
        setAuthStatus("Signed in");
      }
    }).catch(() => setAuthStatus("Sign in when you are ready")).finally(() => setSessionReady(true));
  }, [role]);

  async function signIn(): Promise<string | null> {
      try {
        const wallet = await connectWallet();
        setAddress(wallet.address);
        setChainId(wallet.chainId);
        if (wallet.chainId !== HARDHAT_CHAIN_ID) {
          setAuthStatus("Wrong network — switch MetaMask to Hardhat Local before signing in.");
          return "wrong_network";
        }
        setAuthStatus("Waiting for signature");
        const signedInUser = await signInWithWallet(wallet.signer);
        setAuthenticatedAddress(signedInUser.walletAddress || wallet.address);
        const selectedUser = role ? await selectRole(role) : signedInUser;
        setAuthUser(selectedUser);
        setAuthStatus("Signed in");
        setWalletStatus("Wallet authenticated for EventRent");
        if (!contractAddress) {
          setContract(null);
          setWalletStatus("Wallet authenticated; escrow contract is not configured.");
        } else if (await wallet.provider.getCode(contractAddress) === "0x") {
          setContract(null);
          setWalletStatus("Wallet authenticated; no escrow contract was found on Hardhat Local.");
        } else {
          setContract(getRentalEscrow(wallet.signer));
        }
        if (route.path === "landing") {
          const destination = returnDestination || (role === "owner" ? "owner" : "dashboard");
          setReturnDestination(null);
          navigate(destination);
        }
        return null;
      } catch (error) {
        setAuthenticatedAddress("");
        setAuthUser(null);
        const message = error instanceof Error ? error.message : "wallet_authentication_failed";
        setAuthStatus(explainAuthError(error));
        return message;
      }
  }

  async function signOut() {
      try {
        await logout();
      } catch {
        setAuthStatus("The session could not be cleared. It may already have expired.");
      }
      setAuthenticatedAddress("");
      setAuthUser(null);
      setRole(null);
      sessionStorage.removeItem("eventrent-role");
      setAuthStatus("Signed out");
      setReturnDestination(null);
       navigate("");
  }

  function chooseRole(nextRole: AppRole) {
    sessionStorage.setItem("eventrent-role", nextRole);
    setRole(nextRole);
    setAuthOpen(true);
  }

  function openAuth(selectedRole?: AppRole) {
    if (selectedRole) {
      sessionStorage.setItem("eventrent-role", selectedRole);
      setRole(selectedRole);
    }
    setAuthOpen(true);
  }

  useEffect(() => {
    if (!window.ethereum) return;
    const clearWalletSession = () => {
      void logout().catch(() => undefined);
      setAuthenticatedAddress("");
      setAuthUser(null);
      setRole(null);
      sessionStorage.removeItem("eventrent-role");
      setAuthStatus("Wallet changed — sign in again to verify the new account.");
      setAddress("");
      setChainId(null);
      setContract(null);
    };
    const handleAccountsChanged = () => clearWalletSession();
    const handleChainChanged = () => {
      void logout().catch(() => undefined);
      setAuthenticatedAddress("");
      setAuthUser(null);
      setRole(null);
      sessionStorage.removeItem("eventrent-role");
      setAuthStatus("Network changed — sign in again after switching to Hardhat Local.");
      setWalletStatus("Network changed — wallet connection needs to be checked again.");
      setChainId(null);
      setContract(null);
    };
    const handleDisconnect = () => {
      void logout().catch(() => undefined);
      setAuthenticatedAddress("");
      setAuthUser(null);
      setRole(null);
      sessionStorage.removeItem("eventrent-role");
      setAddress("");
      setChainId(null);
      setContract(null);
      setWalletStatus("Wallet disconnected");
    };
    window.ethereum.on("accountsChanged", handleAccountsChanged);
    window.ethereum.on("chainChanged", handleChainChanged);
    window.ethereum.on("disconnect", handleDisconnect);
    return () => {
      window.ethereum?.removeListener("accountsChanged", handleAccountsChanged);
      window.ethereum?.removeListener("chainChanged", handleChainChanged);
      window.ethereum?.removeListener("disconnect", handleDisconnect);
    };
  }, []);

  const protectedRoute = protectedRouteFor(route);
  if (authUser && role !== "owner" && route.path.startsWith("owner")) return null;
  if (route.path === "landing" || (protectedRoute && (!sessionReady || !authUser))) return <><LandingPage onNavigate={navigate} onChooseRole={chooseRole} onSignIn={() => openAuth()} /><WalletAuthDialog role={role} open={authOpen} onClose={() => setAuthOpen(false)} onRoleChange={(nextRole) => { sessionStorage.setItem("eventrent-role", nextRole); setRole(nextRole); }} onConnect={async () => { const error = await signIn(); if (error) throw new Error(explainAuthError(new Error(error))); setAuthOpen(false); }} /></>;

  return (
    <div className="product-shell">
      <WorkspaceSidebar route={route.path} role={role ?? "renter"} onNavigate={navigate} />
      <div className="workspace">
        <header className="workspace-header">
          <button className="mobile-brand" onClick={() => navigate("dashboard")}><span className="brand-mark">ER</span> EventRent</button>
          <div className="header-context">Equipment rental &amp; protected deposits</div>
          {authenticatedAddress || authUser ? <button className="header-wallet" onClick={() => void signOut()}><span className="wallet-dot connected" />{authenticatedAddress ? `${authenticatedAddress.slice(0, 6)}…${authenticatedAddress.slice(-4)}` : "MetaMask signed in"} · Sign out</button> : <button className="header-wallet" onClick={() => openAuth()}><span className={`wallet-dot ${address ? "connected" : ""}`} />{address ? "Sign in with MetaMask" : "Connect MetaMask"}</button>}
        </header>
        <main className="page-content">
          {!contractAddress && <div className="setup-banner">Connect a deployed contract by configuring <code>VITE_RENTAL_ESCROW_ADDRESS</code> in <code>frontend/.env.local</code>.</div>}
          {route.path === "dashboard" && <HomePage role={role ?? "renter"} contract={contract} chainId={chainId} onNavigate={navigate} />}
          {route.path === "how-it-works" && <HowItWorksPage />}
          {route.path === "trust" && <TrustPage />}
          {route.path === "equipment" && <EquipmentPage authUser={authUser} onNavigate={navigate} />}
          {route.path === "equipment/detail" && <EquipmentDetailsPage equipmentId={route.id ?? ""} authUser={authUser} onNavigate={navigate} />}
          {route.path === "rentals" && <RentalsPage onNavigate={navigate} filter="all" />}
          {route.path === "rentals/upcoming" && <RentalsPage onNavigate={navigate} filter="upcoming" />}
          {route.path === "rentals/active" && <RentalsPage onNavigate={navigate} filter="active" />}
          {route.path === "rentals/completed" && <RentalsPage onNavigate={navigate} filter="completed" />}
          {route.path === "rentals/create" && <CreateRentalPage contract={contract} onNavigate={navigate} />}
          {route.path === "rentals/detail" && <RentalDetailsPage contract={contract} rentalId={route.id ?? "1"} address={address} chainId={chainId} onNavigate={navigate} />}
          {route.path === "disputes" && <DisputesPage onNavigate={navigate} />}
          {route.path === "activity" && <ActivityPage onNavigate={navigate} />}
            {route.path === "owner" && <OwnerWorkspacePage contract={contract} chainId={chainId} onNavigate={navigate} section="overview" />}
            {route.path === "owner/equipment" && <OwnerWorkspacePage contract={contract} chainId={chainId} onNavigate={navigate} section="equipment" />}
            {route.path === "owner/add-equipment" && <OwnerWorkspacePage contract={contract} chainId={chainId} onNavigate={navigate} section="add-equipment" />}
            {route.path === "owner/rentals" && <OwnerWorkspacePage contract={contract} chainId={chainId} onNavigate={navigate} section="bookings" />}
            {route.path === "owner/returns" && <OwnerWorkspacePage contract={contract} chainId={chainId} onNavigate={navigate} section="returns" />}
           {route.path === "settings" && <SettingsPage user={authUser} address={address} chainId={chainId} walletStatus={walletStatus} onSignOut={() => void signOut()} />}
           {route.path === "not-found" && <EmptyPage eyebrow="PAGE NOT FOUND" title="That route does not exist." description="EventRent could not find the page you requested." note="Return to the marketplace or go back to your workspace." />}
          <p className="wallet-status">{walletStatus}{chainId ? ` · Chain ${chainId.toString()}` : ""} · {authStatus}</p>
        </main>
       </div>
       <WalletAuthDialog role={role} open={authOpen} onClose={() => setAuthOpen(false)} onRoleChange={(nextRole) => { sessionStorage.setItem("eventrent-role", nextRole); setRole(nextRole); }} onConnect={async () => { const error = await signIn(); if (error) throw new Error(explainAuthError(new Error(error))); setAuthOpen(false); }} />
       <div className="mobile-nav">
        <NavItem label="Home" icon="⌂" active={route.path === "dashboard"} onClick={() => navigate("dashboard")} />
        <NavItem label="Gear" icon="▧" active={route.path.startsWith("equipment")} onClick={() => navigate("equipment")} />
        <NavItem label="Rentals" icon="▤" active={route.path.startsWith("rentals")} onClick={() => navigate("rentals")} />
        <NavItem label="Activity" icon="◷" active={route.path === "activity"} onClick={() => navigate("activity")} />
      </div>
    </div>
  );
}

function LandingPage({ onNavigate, onChooseRole, onSignIn }: { onNavigate: (path: string) => void; onChooseRole: (role: AppRole) => void; onSignIn: () => void }) {
  return (
    <div className="landing">
      <header className="landing-header">
        <a className="brand" href="#/"><span className="brand-mark">ER</span> EventRent</a>
        <nav><a href="#/">Home</a><a href="#/equipment">Browse equipment</a><a href="#/how-it-works">How deposits work</a><button className="landing-login" onClick={onSignIn}>Connect MetaMask</button><button className="landing-login" onClick={() => document.getElementById("choose-role")?.scrollIntoView({ behavior: "smooth" })}>Get started</button></nav>
      </header>
      <main>
        <section className="landing-hero">
          <div className="hero-copy">
            <span className="eyebrow">EVENT EQUIPMENT, READY WHEN YOU ARE</span>
            <h1>Rent the gear.<br /><em>Protect the deposit.</em></h1>
            <p>Find the speakers, cameras, projectors, and lighting your event needs. EventRent keeps the physical rental experience simple while programmable escrow keeps the security deposit clear for everyone.</p>
            <div className="landing-actions"><button className="button-primary" onClick={onSignIn}>Connect MetaMask <span>→</span></button><a className="button-text" href="#wallet-login">See the login steps <span>↓</span></a></div>
          </div>
          <EquipmentStage />
        </section>
        <section className="wallet-login-section" id="wallet-login">
          <div className="section-intro"><span className="eyebrow">METAMASK ONLY</span><h2>Start locally in three steps.</h2><p>EventRent uses your MetaMask wallet for login and blockchain actions. There is no Gmail, email, or password account to create.</p></div>
          <div className="wallet-steps-grid"><div className="wallet-step"><span>01</span><strong>Start Hardhat</strong><p>Run <code>npx hardhat node</code> in the project root and keep the local node running.</p></div><div className="wallet-step"><span>02</span><strong>Use a test account</strong><p>Import a disposable Hardhat account into MetaMask and keep the network on chain 31337.</p></div><div className="wallet-step"><span>03</span><strong>Connect and sign</strong><p>Click Connect MetaMask. EventRent adds or switches to Hardhat Local, then asks for a free sign-in message.</p></div></div>
          <p className="wallet-network-hint"><strong>Hardhat Local</strong> · RPC <code>http://127.0.0.1:8545</code> · Chain ID <code>31337</code> · Currency <code>ETH</code></p>
          <button className="button-primary wallet-login-button" onClick={onSignIn}>Connect MetaMask →</button>
        </section>
        <section className="journey-section" id="how-it-works">
          <div className="section-intro"><span className="eyebrow">THE RENTAL JOURNEY</span><h2>From event plan to pack-down.</h2><p>Every important step is easy to understand, including what happens to the deposit.</p></div>
          <div className="journey-grid">{["Choose the gear", "Start the rental", "Deposit is protected", "Return equipment", "Deposit is released"].map((step, index) => <div className="journey-step" key={step}><span>0{index + 1}</span><strong>{step}</strong><p>{["Pick equipment that fits the occasion.", "Agree the dates and rental terms.", "The contract holds the security deposit.", "Confirm the equipment has come back.", "Settlement makes the claim available."][index]}</p></div>)}</div>
        </section>
        <section className="role-choice" id="choose-role"><div className="section-intro"><span className="eyebrow">CHOOSE YOUR EVENTRENT PATH</span><h2>Choose one workspace for this session.</h2><p>Renter and owner workspaces are intentionally separated. Sign out before choosing a different workspace or wallet.</p></div><div className="role-choice-grid"><button className="role-choice-card" onClick={() => onChooseRole("renter")}><span className="role-card-icon">↗</span><strong>I'm looking to rent</strong><small>Discover equipment, request dates, protect a deposit, and track your bookings.</small><span className="role-card-link">Continue as a renter →</span></button><button className="role-choice-card" onClick={() => onChooseRole("owner")}><span className="role-card-icon">⌂</span><strong>I want to list my equipment</strong><small>Publish equipment, manage your inventory, and handle incoming rental requests.</small><span className="role-card-link">Continue as an owner →</span></button></div></section><section className="landing-values"><ValueCard title="Gear-first experience" text="Browse equipment as you would on a real rental service, not a blockchain explorer." /><ValueCard title="Clear money moments" text="Rental fee and security deposit are shown separately before you authorize anything." /><ValueCard title="A fair record" text="Rental milestones and settlement rules are recorded transparently for both sides." /></section>
      </main>
      <footer className="landing-footer"><span>EventRent</span><span>Equipment rental with a clearer deposit experience.</span></footer>
    </div>
  );
}

function AuthDialog({ initialMode, role, open, onClose, onRoleChange, onWalletSignIn, onAuthenticated }: { initialMode: "login" | "register"; role: AppRole | null; open: boolean; onClose: () => void; onRoleChange: (role: AppRole) => void; onWalletSignIn: () => Promise<void>; onAuthenticated: (user: AuthUser) => Promise<void> }) {
  const [mode, setMode] = useState<"login" | "register" | "forgot">(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);
  const [pendingEmail, setPendingEmail] = useState("");
  const [resendMessage, setResendMessage] = useState("");
  useEffect(() => { if (open) { setMode(initialMode); setPendingEmail(""); setMessage(""); } }, [open, initialMode]);
  if (!open) return null;
  async function submit(event: FormEvent) {
    event.preventDefault();
    setWorking(true);
    setMessage("");
    try {
      if (mode === "forgot") {
        await requestPasswordReset(email);
        setMessage("If a verified account exists for that email, a reset link has been sent.");
      } else if (mode === "login") {
        await onAuthenticated(await loginWithEmail(email, password));
      } else {
        const result = await registerWithEmail(email, password);
        setPendingEmail(email);
        setResendMessage("Check your inbox for a single-use verification link.");
        setPassword("");
        if (!result.verificationRequired) await onAuthenticated(result.user);
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      setMessage(code.includes("email_already_registered") ? "An account already exists for that email." : code.includes("email_not_verified") ? "Verify your email before signing in." : code.includes("email_delivery_unavailable") ? "Email delivery is not configured on the backend." : code.includes("verification_resend_cooldown") ? "Please wait before requesting another email." : code.includes("too_many_attempts") ? "Too many failed attempts. Wait a few minutes and try again." : code.includes("invalid_credentials") ? "Email or password is incorrect." : code.includes("invalid_registration") ? "Use a valid email and a password of at least 12 characters." : code.includes("role_selection_failed") || code.includes("404") ? "The backend role service is unavailable. Restart the backend and try again." : code.includes("MetaMask") || code.includes("wallet_") || code.includes("network") ? (error instanceof Error ? error.message : "Wallet authentication could not be completed.") : "Authentication failed. Check the backend and try again.");
    } finally {
      setWorking(false);
    }
  }
  if (pendingEmail) return <div className="auth-overlay" role="dialog" aria-modal="true"><div className="auth-dialog"><button className="auth-close" onClick={onClose} aria-label="Close authentication dialog">×</button><span className="eyebrow">EMAIL VERIFICATION</span><h2>Check your email.</h2><p className="auth-intro">We sent a single-use verification link to <strong>{pendingEmail}</strong>. Verify it before signing in or using protected marketplace actions.</p><button className="outline-button" disabled={working} onClick={async () => { setWorking(true); setResendMessage(""); try { await resendVerification(pendingEmail); setResendMessage("A new verification email was sent."); } catch (error) { setResendMessage(error instanceof Error && error.message === "verification_resend_cooldown" ? "Please wait before requesting another email." : "The verification email could not be sent."); } finally { setWorking(false); } }}>{working ? "Sending..." : "Resend verification email"}</button><p className="auth-note">{resendMessage}</p><button className="button-text" onClick={() => setPendingEmail("")}>Back to sign in</button></div></div>;
  return <div className="auth-overlay" role="dialog" aria-modal="true" aria-labelledby="auth-title"><div className="auth-dialog"><button className="auth-close" onClick={onClose} aria-label="Close authentication dialog">×</button><span className="eyebrow">EVENTRENT ACCOUNT</span><h2 id="auth-title">{mode === "login" ? "Welcome back." : mode === "register" ? "Create your account." : "Reset your password."}</h2><p className="auth-intro">{mode === "forgot" ? "Enter your email and we will send a reset link if a verified account exists." : "Use your existing EventRent account for either workflow. Your selected workspace only changes navigation; backend permissions still come from your authenticated account."}</p>{mode !== "forgot" && <><div className="auth-role-picker" aria-label="Choose workspace"><button type="button" className={role === "renter" ? "active" : ""} onClick={() => onRoleChange("renter")}>I'm looking to rent</button><button type="button" className={role === "owner" ? "active" : ""} onClick={() => onRoleChange("owner")}>I want to list my equipment</button></div><p className="auth-role-note">{role ? `You'll enter the ${role} workspace after authentication.` : "Choose a path to continue."}</p><div className="auth-tabs"><button type="button" className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Sign in</button><button type="button" className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>Register</button></div></>}{mode === "forgot" && <p className="auth-role-note">Password recovery returns you to sign in. Your workspace choice is not changed.</p>}<form onSubmit={submit} className="auth-form"><label>Email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>{mode !== "forgot" && <label>Password<input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} required /><small>Use at least 12 characters.</small></label>}<button className="button-primary" type="submit" disabled={working || (mode !== "forgot" && !role)}>{working ? "Please wait..." : mode === "login" ? "Sign in with email" : mode === "register" ? "Create account" : "Send reset link"}</button></form>{message && <p className={`message ${mode === "forgot" ? "success" : "error"}`}>{message}</p>}{mode === "login" && <><button className="button-text" onClick={() => { setMode("forgot"); setMessage(""); }}>Forgot password?</button><div className="auth-divider"><span>Optional</span></div><button className="outline-button" onClick={async () => { setWorking(true); setMessage(""); try { await onWalletSignIn(); } catch (error) { const code = error instanceof Error ? error.message : ""; setMessage(code.includes("MetaMask") ? code : code.includes("wallet_permission_rejected") ? "Wallet access was rejected. Approve the connection in MetaMask or try again." : code.includes("wrong network") ? "Switch MetaMask to Hardhat Local before signing in." : "Wallet authentication could not be completed."); } finally { setWorking(false); } }} disabled={!role || working}>{working ? "Waiting for wallet..." : "Connect MetaMask and sign in"}</button><p className="auth-note">MetaMask authentication is separate from email verification. A wallet is still required when authorizing blockchain rental actions.</p></>}</div></div>;
}

function WalletAuthDialog({ role, open, onClose, onRoleChange, onConnect }: { role: AppRole | null; open: boolean; onClose: () => void; onRoleChange: (role: AppRole) => void; onConnect: () => Promise<void> }) {
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  if (!open) return null;
  async function connect() {
    if (!role) {
      setMessage("Choose a renter or owner workspace first.");
      return;
    }
    setWorking(true);
    setMessage("");
    try {
      await onConnect();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "MetaMask sign-in could not be completed.");
    } finally {
      setWorking(false);
    }
  }
  return <div className="auth-overlay" role="dialog" aria-modal="true" aria-labelledby="wallet-auth-title"><div className="auth-dialog wallet-auth-dialog"><button className="auth-close" onClick={onClose} aria-label="Close MetaMask sign-in">×</button><span className="eyebrow">METAMASK ONLY</span><h2 id="wallet-auth-title">Connect your wallet.</h2><p className="auth-intro">EventRent uses a signed MetaMask message as login. No Gmail, email, password, or verification link is required.</p><div className="auth-role-picker" aria-label="Choose workspace"><button type="button" className={role === "renter" ? "active" : ""} onClick={() => onRoleChange("renter")}>I'm looking to rent</button><button type="button" className={role === "owner" ? "active" : ""} onClick={() => onRoleChange("owner")}>I want to list equipment</button></div><p className="auth-role-note">{role ? `You'll enter the ${role} workspace after MetaMask sign-in.` : "Choose a workspace to continue."}</p><ol className="wallet-login-steps"><li>Start <code>npx hardhat node</code> in the project root.</li><li>Import a disposable Hardhat account into MetaMask.</li><li>Approve the automatic Hardhat Local network switch and sign the free login message.</li></ol><button className="button-primary wallet-connect-button" disabled={working || !role} onClick={() => void connect()}>{working ? "Waiting for MetaMask..." : "Connect MetaMask"}</button>{message && <p className="message error">{message}</p>}<p className="auth-note">The signature proves wallet ownership and does not send a blockchain transaction.</p></div></div>;
}

function PasswordResetPage({ token, onComplete }: { token?: string; onComplete: () => void }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState(token ? "" : "This reset link is missing its token.");
  const [working, setWorking] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!token) return;
    if (password.length < 12 || password !== confirmation) {
      setMessage(password !== confirmation ? "Passwords do not match." : "Use at least 12 characters.");
      return;
    }
    setWorking(true);
    try {
      await confirmPasswordReset(token, password);
      setMessage("Your password was reset. Sign in with the new password.");
      setTimeout(onComplete, 700);
    } catch (error) {
      setMessage(error instanceof Error && error.message === "invalid_or_expired_password_reset" ? "This reset link is invalid, expired, or already used." : "The password could not be reset. Request a new link and try again.");
    } finally {
      setWorking(false);
    }
  }
  return <section className="verification-card"><span className="eyebrow">PASSWORD RESET</span><h1>Choose a new password.</h1><form className="auth-form" onSubmit={submit}><label>New password<input type="password" autoComplete="new-password" minLength={12} value={password} onChange={(event) => setPassword(event.target.value)} required /></label><label>Confirm password<input type="password" autoComplete="new-password" minLength={12} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required /></label><button className="button-primary" disabled={working || !token}>{working ? "Resetting..." : "Reset password"}</button></form>{message && <p className={`message ${message.startsWith("Your password") ? "success" : "error"}`}>{message}</p>}</section>;
}

function EmailVerificationPage({ token, onAuthenticated }: { token?: string; onAuthenticated: (user: AuthUser) => void }) {
  const [message, setMessage] = useState(token ? "Verifying your email..." : "This verification link is missing its token.");
  useEffect(() => {
    if (!token) return;
    void verifyEmailToken(token).then((user) => onAuthenticated(user)).catch((error) => setMessage(error instanceof Error && error.message === "invalid_or_expired_verification" ? "This verification link is invalid, expired, or already used." : "Email verification could not be completed."));
  }, [token, onAuthenticated]);
  return <section className="verification-card"><span className="eyebrow">EMAIL VERIFICATION</span><h1>{message}</h1><p>Verification links are single-use and expire. You may close this page after the account is verified.</p></section>;
}

function EquipmentStage() {
  return <div className="equipment-stage"><div className="stage-label">THIS WEEK'S SETUP <span>●</span></div><div className="stage-floor" /><EquipmentVisual type="speaker" accent="coral" /><EquipmentVisual type="projector" accent="gold" /><EquipmentVisual type="lighting" accent="purple" /><div className="stage-note"><strong>Ready for the next event</strong><span>Sound · projection · lighting</span></div></div>;
}

function AppSidebar({ route, role, address, onNavigate, onChooseRole }: { route: string; role: AppRole; address: string; onNavigate: (path: string) => void; onChooseRole: (role: AppRole) => void }) {
  const owner = role === "owner";
  return <aside className="sidebar"><button className="sidebar-brand" onClick={() => onNavigate(owner ? "owner" : "dashboard")}><span className="brand-mark">ER</span><span>EventRent</span></button><span className="sidebar-label">{owner ? "OWNER WORKSPACE" : "RENTER WORKSPACE"}</span><nav className="sidebar-nav">{owner ? <><NavItem label="Overview" icon="⌂" active={route === "owner"} onClick={() => onNavigate("owner")} /><NavItem label="My equipment" icon="▧" active={route === "owner/equipment"} onClick={() => onNavigate("owner/equipment")} /><NavItem label="Add equipment" icon="＋" active={route === "owner/add-equipment"} onClick={() => onNavigate("owner/add-equipment")} /><NavItem label="Bookings" icon="▤" active={route === "owner/rentals"} onClick={() => onNavigate("owner/rentals")} /><NavItem label="Returns" icon="↩" active={route === "owner/returns"} onClick={() => onNavigate("owner/returns")} /><NavItem label="Disputes" icon="◇" active={route === "disputes"} onClick={() => onNavigate("disputes")} /></> : <><NavItem label="Dashboard" icon="⌂" active={route === "dashboard"} onClick={() => onNavigate("dashboard")} /><NavItem label="Browse equipment" icon="▧" active={route.startsWith("equipment")} onClick={() => onNavigate("equipment")} /><NavItem label="My rentals" icon="▤" active={route.startsWith("rentals")} onClick={() => onNavigate("rentals")} /><NavItem label="Upcoming" icon="◷" active={route === "rentals/upcoming"} onClick={() => onNavigate("rentals/upcoming")} /><NavItem label="Active rentals" icon="●" active={route === "rentals/active"} onClick={() => onNavigate("rentals/active")} /><NavItem label="Completed" icon="✓" active={route === "rentals/completed"} onClick={() => onNavigate("rentals/completed")} /><NavItem label="Disputes" icon="◇" active={route === "disputes"} onClick={() => onNavigate("disputes")} /></>}</nav><div className="sidebar-bottom"><button className="role-switcher" onClick={() => onChooseRole(owner ? "renter" : "owner")}>Switch to {owner ? "renter" : "owner"} workspace</button><NavItem label="Activity" icon="◷" active={route === "activity"} onClick={() => onNavigate("activity")} /><div className="sidebar-wallet"><span className={`wallet-dot ${address ? "connected" : ""}`} /><div><strong>{address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "Wallet disconnected"}</strong><small>{address ? "Ready to authorize" : "Connect from the top bar"}</small></div></div></div></aside>;
}

function WorkspaceSidebar({ route, role, onNavigate }: { route: string; role: AppRole; onNavigate: (path: string) => void }) {
  const owner = role === "owner";
  return <aside className="sidebar"><button className="sidebar-brand" onClick={() => onNavigate(owner ? "owner" : "dashboard")}><span className="brand-mark">ER</span><span>EventRent</span></button><span className="sidebar-label">{owner ? "OWNER WORKSPACE" : "RENTER WORKSPACE"}</span><nav className="sidebar-nav">{owner ? <><NavItem label="Owner dashboard" icon="⌂" active={route === "owner"} onClick={() => onNavigate("owner")} /><NavItem label="Added equipment" icon="▧" active={route === "owner/equipment"} onClick={() => onNavigate("owner/equipment")} /><NavItem label="Add equipment" icon="＋" active={route === "owner/add-equipment"} onClick={() => onNavigate("owner/add-equipment")} /><NavItem label="All bookings" icon="▤" active={route === "owner/rentals"} onClick={() => onNavigate("owner/rentals")} /><NavItem label="Returns" icon="↩" active={route === "owner/returns"} onClick={() => onNavigate("owner/returns")} /><NavItem label="Disputes" icon="◇" active={route === "disputes"} onClick={() => onNavigate("disputes")} /></> : <><NavItem label="Renter dashboard" icon="⌂" active={route === "dashboard"} onClick={() => onNavigate("dashboard")} /><NavItem label="Browse equipment" icon="▧" active={route.startsWith("equipment")} onClick={() => onNavigate("equipment")} /><NavItem label="My rentals" icon="▤" active={route.startsWith("rentals")} onClick={() => onNavigate("my-rentals")} /><NavItem label="Upcoming" icon="◷" active={route === "rentals/upcoming"} onClick={() => onNavigate("rentals/upcoming")} /><NavItem label="Active rentals" icon="●" active={route === "rentals/active"} onClick={() => onNavigate("rentals/active")} /><NavItem label="Completed" icon="✓" active={route === "rentals/completed"} onClick={() => onNavigate("rentals/completed")} /><NavItem label="Activity" icon="◴" active={route === "activity"} onClick={() => onNavigate("activity")} /></>}</nav><div className="sidebar-bottom"><div className="sidebar-role-note">Signed in as <strong>{owner ? "Owner" : "Renter"}</strong><small>Only this workspace is available for this session.</small></div></div></aside>;
}

function NavItem({ label, icon, active, onClick }: { label: string; icon: string; active: boolean; onClick: () => void }) {
  return <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick}><span className="nav-icon">{icon}</span>{label}</button>;
}

function LegacyHomePage({ role, contract, chainId, onNavigate }: { role: AppRole; contract: Contract | null; chainId: bigint | null; onNavigate: (path: string) => void }) {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    if (role !== "renter") {
      setLoading(false);
      return;
    }
    void fetchBookings().then(setBookings).catch(() => setError("Your bookings could not be loaded right now.")).finally(() => setLoading(false));
  }, [role]);
  if (role === "owner") return <OwnerWorkspacePage contract={contract} chainId={chainId} onNavigate={onNavigate} section="overview" />;
  return <PageHeader eyebrow="RENTER DASHBOARD" title="Good to see you." description="Find the gear for your next event, then track the deposit through every rental stage."><section className="home-callout"><div><span className="eyebrow">READY FOR YOUR NEXT EVENT?</span><h2>Find the equipment that makes the room work.</h2><p>Browse the catalogue or look up a rental record when you already have an ID.</p><button className="button-primary" onClick={() => onNavigate("equipment")}>Browse equipment →</button></div><div className="mini-stage"><EquipmentVisual type="microphone" accent="blue" /><EquipmentVisual type="speaker" accent="coral" /></div></section><div className="home-columns"><section className="content-panel"><PanelHeading title="My rentals" action="View all" onAction={() => onNavigate("rentals")} />{loading ? <div className="empty-state"><strong>Loading your bookings...</strong><p>Checking booking and escrow status.</p></div> : error ? <div className="empty-state"><strong>{error}</strong><button className="outline-button" onClick={() => window.location.reload()}>Try again</button></div> : bookings.length ? <div className="booking-list">{bookings.slice(0, 3).map((booking) => <article className="booking-row" key={booking.id}><div><span className="card-kicker">Booking #{booking.id}</span><h3>{booking.name}</h3><p>{new Date(booking.startTime).toLocaleDateString()} – {new Date(booking.endTime).toLocaleDateString()}</p></div><div><strong>{booking.status}</strong><small>{booking.onchainRentalId ? `Escrow #${booking.onchainRentalId} · ${booking.onchainRentalStatus || "CREATED"}` : "Awaiting owner approval"}</small></div></article>)}</div> : <EmptyState title="You haven't requested equipment yet." note="Browse the catalogue to start a rental. Booking requests and verified escrow records will appear here." action="Browse equipment" onAction={() => onNavigate("equipment")} />}</section><section className="content-panel"><PanelHeading title="Deposit protection" /><div className="protection-copy"><span className="protection-mark">✓</span><div><strong>Terms first, settlement second.</strong><p>Your security deposit is held by the rental contract and becomes claimable only when the agreed lifecycle allows it.</p></div></div></section></div></PageHeader>;
}

function HomePage({ role, contract, chainId, onNavigate }: { role: AppRole; contract: Contract | null; chainId: bigint | null; onNavigate: (path: string) => void }) {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    if (role === "owner") {
      setLoading(false);
      return;
    }
    void fetchBookings().then(setBookings).catch(() => setError("Your rentals could not be loaded right now.")).finally(() => setLoading(false));
  }, [role]);
  if (role === "owner") return <OwnerWorkspacePage contract={contract} chainId={chainId} onNavigate={onNavigate} section="overview" />;
  const approved = bookings.filter((booking) => booking.status === "APPROVED");
  const active = bookings.filter((booking) => booking.onchainRentalStatus === "ACTIVE");
  const upcoming = bookings.filter((booking) => new Date(booking.startTime).getTime() > Date.now() && booking.status !== "REJECTED");
  return <PageHeader eyebrow="RENTER DASHBOARD" title="Your rental desk" description="See your booking progress, approved requests, and active escrow in one place."><div className="dashboard-metrics"><article className="metric-card"><span className="eyebrow">ALL REQUESTS</span><strong>{loading ? "—" : bookings.length}</strong><small>Bookings created by this wallet</small></article><article className="metric-card"><span className="eyebrow">UPCOMING</span><strong>{loading ? "—" : upcoming.length}</strong><small>Future requests and approvals</small></article><article className="metric-card"><span className="eyebrow">APPROVED</span><strong>{loading ? "—" : approved.length}</strong><small>Ready for owner escrow actions</small></article><article className="metric-card"><span className="eyebrow">ACTIVE</span><strong>{loading ? "—" : active.length}</strong><small>Rentals currently in progress</small></article></div><section className="home-callout"><div><span className="eyebrow">RENTER WORKSPACE</span><h2>Find equipment, then follow the booking.</h2><p>Browse owner-published equipment or open your complete My rentals page to see every request and escrow status.</p><div className="dashboard-actions"><button className="button-primary" onClick={() => onNavigate("equipment")}>Browse equipment →</button><button className="outline-button dashboard-secondary-action" onClick={() => onNavigate("my-rentals")}>Open My rentals</button></div></div><div className="mini-stage"><EquipmentVisual type="microphone" accent="blue" /><EquipmentVisual type="speaker" accent="coral" /></div></section><div className="home-columns"><section className="content-panel"><PanelHeading title="Recent rentals" action="View all" onAction={() => onNavigate("my-rentals")} />{loading ? <div className="empty-state"><strong>Loading your rentals...</strong><p>Checking booking and escrow status.</p></div> : error ? <div className="empty-state"><strong>{error}</strong><button className="outline-button" onClick={() => window.location.reload()}>Try again</button></div> : bookings.length ? <div className="booking-list">{bookings.slice(0, 5).map((booking) => <article className="booking-row" key={booking.id}><div><span className="card-kicker">Booking #{booking.id}</span><h3>{booking.name}</h3><p>{new Date(booking.startTime).toLocaleDateString()} – {new Date(booking.endTime).toLocaleDateString()}</p></div><div><strong>{booking.status}</strong><small>{booking.onchainRentalId ? `Escrow #${booking.onchainRentalId} · ${booking.onchainRentalStatus || "CREATED"}` : "Waiting for owner approval"}</small></div></article>)}</div> : <EmptyState title="No rentals yet" note="Your booking requests will appear here after you request equipment." action="Browse equipment" onAction={() => onNavigate("equipment")} />}</section><section className="content-panel"><PanelHeading title="Renter tools" /><div className="dashboard-tool-list"><button className="dashboard-tool" onClick={() => onNavigate("my-rentals")}><strong>My rentals</strong><span>All requests, approvals, and escrow records →</span></button><button className="dashboard-tool" onClick={() => onNavigate("equipment")}><strong>Browse equipment</strong><span>See owner images and serial validation →</span></button><button className="dashboard-tool" onClick={() => onNavigate("activity")}><strong>Blockchain activity</strong><span>Review verified escrow transactions →</span></button></div></section></div></PageHeader>;
}

function EquipmentPage({ authUser, onNavigate }: { authUser: AuthUser | null; onNavigate: (path: string) => void }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All equipment");
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => { setLoading(true); setError(""); void fetchListings(query, category === "All equipment" ? "" : category).then((rows) => setListings(authUser ? rows.filter((listing) => listing.ownerId !== authUser.id) : rows)).catch(() => { setListings([]); setError("The marketplace could not be loaded. Check that the backend is running and try again."); }).finally(() => setLoading(false)); }, [authUser, query, category]);
  const categories = ["All equipment", "Sound", "Projection", "Capture", "Lighting", "Accessories"];
  return <PageHeader eyebrow="THE MARKETPLACE" title="Find your event gear" description="Browse persistent local marketplace listings. Availability is confirmed again when a booking is created and when the deposit is funded on-chain."><div className="catalogue-note"><span>LOCAL MVP LISTINGS</span><p>These records are stored by the EventRent backend. They are local demonstration inventory, not verified commercial availability.</p></div><div className="catalogue-toolbar"><label className="catalogue-search"><span>Search equipment</span><input type="search" placeholder="Try “camera” or “sound”" value={query} onChange={(event) => setQuery(event.target.value)} /></label><label className="catalogue-filter"><span>Category</span><select value={category} onChange={(event) => setCategory(event.target.value)}>{categories.map((item) => <option key={item}>{item}</option>)}</select></label></div><div className="category-nav" aria-label="Equipment categories">{categories.map((item) => <button className={category === item ? "category-chip active" : "category-chip"} key={item} onClick={() => setCategory(item)}>{item}</button>)}</div>{loading ? <div className="empty-state"><strong>Loading equipment...</strong><p>Reading the latest local listings.</p></div> : error ? <div className="empty-state"><strong>{error}</strong><button className="outline-button" onClick={() => window.location.reload()}>Try again</button></div> : listings.length ? <div className="catalogue-grid">{listings.map((item) => <ListingCard key={item.id} listing={item} onClick={() => onNavigate(`equipment/${item.id}`)} />)}</div> : <EmptyState title="No listings match" note="Try a different search or category, or add the first listing from the owner workspace." />}</PageHeader>;
}

function ListingCard({ listing, onClick }: { listing: Listing; onClick: () => void }) {
  const visual = listing.category.toLowerCase().includes("sound") ? "speaker" : listing.category.toLowerCase().includes("projection") ? "projector" : listing.category.toLowerCase().includes("lighting") ? "lighting" : "camera";
  return <article className="equipment-card"><div className="equipment-art coral"><span className="art-index">#{listing.id}</span>{listing.imageUrl ? <img className="listing-image" src={listing.imageUrl} alt={`${listing.name} equipment`} /> : <ListingPlaceholder type={visual} />}<span className="availability">{listing.serialId ? "Serial validated" : "Validation pending"}</span></div><div className="equipment-card-body"><span className="card-kicker">{listing.ownerName} · {listing.category}</span><h2>{listing.name}</h2><p>{listing.description}</p><p className="listing-serial"><strong>Serial ID:</strong> {listing.serialId || "Owner validation pending"}</p><div className="equipment-price"><span><small>Daily rental</small><strong>{listing.dailyFee} ETH</strong></span><span><small>Refundable deposit</small><strong>{listing.deposit} ETH</strong></span></div><button className="outline-button" onClick={onClick}>View equipment <span>→</span></button></div></article>;
}

function EquipmentCard({ equipment, onClick }: { equipment: Equipment; onClick: () => void }) {
  return <article className="equipment-card"><div className={`equipment-art ${equipment.accent}`}><span className="art-index">{equipment.id}</span><EquipmentVisual type={equipment.visual} accent={equipment.accent} /><span className="availability">Owner listing</span></div><div className="equipment-card-body"><span className="card-kicker">{equipment.type}</span><h2>{equipment.name}</h2><p>{equipment.description}</p><div className="equipment-price"><span><small>Daily rental</small><strong>{equipment.fee}</strong></span><span><small>Refundable deposit</small><strong>{equipment.deposit}</strong></span></div><button className="outline-button" onClick={onClick}>View equipment <span>→</span></button></div></article>;
}

function EquipmentDetailsPage({ equipmentId, authUser, onNavigate }: { equipmentId: string; authUser: AuthUser | null; onNavigate: (path: string) => void }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const equipment = catalogue.find((item) => item.id === equipmentId);
  useEffect(() => { if (!equipment) { void fetch(`/api/listings/${equipmentId}`, { credentials: "include" }).then(async (response) => { if (!response.ok) throw new Error("listing_not_found"); return response.json(); }).then((result) => setListing(result?.listing ?? null)).catch(() => { setListing(null); setError("This listing could not be loaded from the marketplace."); }).finally(() => setLoading(false)); } else setLoading(false); }, [equipment, equipmentId]);
  if (loading) return <EmptyPage eyebrow="MARKETPLACE" title="Loading equipment" description="Reading the listing." note="Please wait." />;
  if (!equipment && !listing) return <EmptyPage eyebrow="CATALOGUE" title="Equipment not found" description={error || "This listing is not available."} note="Return to the equipment catalogue to choose another item." />;
  if (listing) { const ownListing = Boolean(authUser && listing.ownerId === authUser.id); return <PageHeader eyebrow={`${listing.category} · #${listing.id}`} title={listing.name} description={listing.description}><button className="button-text back-link" onClick={() => onNavigate("equipment")}>← Back to equipment</button><div className="equipment-detail"><div className="equipment-detail-art coral">{listing.imageUrl ? <img className="listing-image" src={listing.imageUrl} alt={`${listing.name} equipment`} /> : <ListingPlaceholder type="camera" />}<span>{listing.serialId ? "Owner serial validated" : "Serial validation pending"}</span></div><div className="equipment-detail-copy"><div className="detail-prices"><SummaryRow label="Serial ID" value={listing.serialId || "Validation pending"} /><SummaryRow label="Daily rental fee" value={`${listing.dailyFee} ETH`} /><SummaryRow label="Refundable security deposit" value={`${listing.deposit} ETH`} /><SummaryRow label="Condition" value={listing.condition} /><SummaryRow label="Owner" value={listing.ownerName} /><SummaryRow label="Pickup" value={`${listing.location} · ${listing.pickupDetails}`} /></div><div className="deposit-explainer"><strong>Off-chain booking, on-chain deposit</strong><p>Review the serial ID and item image before requesting dates. Booking details are stored by EventRent; the RentalEscrow contract becomes authoritative when a rental is created and its deposit is funded.</p></div></div></div>{ownListing ? <section className="content-panel owner-listing-notice"><h2>Your equipment listing</h2><p>This is your listing. Manage its details and renter visibility from the owner workspace; booking your own equipment is not available.</p><button className="outline-button" onClick={() => onNavigate("owner/equipment")}>Open owner equipment</button></section> : <BookingForm listingId={listing.id} dailyFee={listing.dailyFee} deposit={listing.deposit} onCreated={() => onNavigate("my-rentals")} />}</PageHeader>; }
  if (!equipment) return <EmptyPage eyebrow="CATALOGUE" title="Equipment not found" description="This listing is not available." note="Return to the equipment catalogue to choose another item." />;
  return <PageHeader eyebrow={`${equipment.type} · ${equipment.id}`} title={equipment.name} description="Review the equipment and understand the money involved before starting a rental."><button className="button-text back-link" onClick={() => onNavigate("equipment")}>← Back to equipment</button><div className="equipment-detail"><div className={`equipment-detail-art ${equipment.accent}`}><EquipmentVisual type={equipment.visual} accent={equipment.accent} /><span>Example catalogue item</span></div><div className="equipment-detail-copy"><p>{equipment.description}</p><div className="detail-prices"><SummaryRow label="Rental fee" value={equipment.fee} /><SummaryRow label="Security deposit" value={equipment.deposit} /><SummaryRow label="Availability" value="Catalogue preview" /></div><div className="deposit-explainer"><strong>Deposit protection</strong><p>Your security deposit is held by the smart contract and released according to the rental rules. It is separate from the rental fee.</p></div><button className="button-primary" onClick={() => onNavigate(`rentals/create?equipment=${equipment.id}`)}>Start rental →</button></div></div></PageHeader>;
}

function RentalsPage({ onNavigate, filter }: { onNavigate: (path: string) => void; filter: "all" | "upcoming" | "active" | "completed" }) {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    setLoading(true);
    setError("");
    void fetchBookings().then(setBookings).catch((reason) => {
      setBookings([]);
      setError(reason instanceof Error && reason.message === "authentication_required" ? "Sign in to load your rentals." : "Your rentals could not be loaded. Try again.");
    }).finally(() => setLoading(false));
  }, []);
  const now = Date.now();
  const filtered = bookings.filter((booking) => {
    if (filter === "all") return true;
    if (filter === "upcoming") return new Date(booking.startTime).getTime() > now && booking.status !== "REJECTED";
    if (filter === "active") return booking.onchainRentalStatus === "ACTIVE";
    return booking.status === "REJECTED" || booking.onchainRentalStatus === "REFUNDED" || booking.onchainRentalStatus === "RESOLVED" || new Date(booking.endTime).getTime() < now;
  });
  const filterLabel = filter === "all" ? "All rentals" : filter[0].toUpperCase() + filter.slice(1);
  return <PageHeader eyebrow="YOUR EVENT DESK" title={filter === "all" ? "My rentals" : `${filterLabel} rentals`} description="Track booking requests separately from confirmed blockchain escrow.">
    <div className="rental-tabs" role="tablist" aria-label="Rental views">
      {(["all", "upcoming", "active", "completed"] as const).map((tab) => <button key={tab} className={`tab ${filter === tab ? "active" : ""}`} onClick={() => onNavigate(tab === "all" ? "rentals" : `rentals/${tab}`)}>{tab === "all" ? "All bookings" : tab[0].toUpperCase() + tab.slice(1)}</button>)}
    </div>
    <section className="content-panel rental-empty-panel">
      {loading ? <div className="empty-state"><strong>Loading your bookings...</strong><p>Checking the latest booking and escrow status.</p></div> : error ? <div className="empty-state"><strong>{error}</strong><button className="outline-button" onClick={() => window.location.reload()}>Reload page</button></div> : filtered.length ? <div className="booking-list">{filtered.map((booking) => <article className="booking-row" key={booking.id}><div><span className="card-kicker">Booking #{booking.id}</span><h3>{booking.name}</h3><p>{new Date(booking.startTime).toLocaleString()} – {new Date(booking.endTime).toLocaleString()}</p></div><div><strong>{booking.status}</strong><small>{booking.onchainRentalId ? `Rental #${booking.onchainRentalId} · ${booking.onchainVerificationStatus || "UNVERIFIED"} · ${booking.onchainRentalStatus || "CREATED"}` : "Off-chain booking · awaiting escrow"}</small>{booking.onchainRentalId && <button className="button-text" onClick={() => onNavigate(`rentals/${booking.onchainRentalId}`)}>Open escrow →</button>}</div></article>)}</div> : <EmptyState title={filter === "all" ? "No booking requests yet" : `No ${filter} rentals`} note={filter === "all" ? "Browse equipment and request dates to see them here." : "Bookings will move into this view when their dates or on-chain status match."} action="Browse equipment" onAction={() => onNavigate("equipment")} />}
    </section>
  </PageHeader>;
}

function CreateRentalPage({ contract, onNavigate }: { contract: Contract | null; onNavigate: (path: string) => void }) {
  return <PageHeader eyebrow="NEW RENTAL" title="Set up your rental" description="A few clear steps to agree the equipment, dates, and protected deposit."><div className="stepper"><span className="current"><b>1</b> Equipment</span><span><b>2</b> Renter</span><span><b>3</b> Rental period</span><span><b>4</b> Deposit</span><span><b>5</b> Review</span></div><div className="creation-layout"><div className="creation-form"><CreateRentalForm contract={contract} /></div><aside className="escrow-summary rental-summary"><span className="eyebrow">YOUR RENTAL</span><div className="summary-visual"><EquipmentVisual type="camera" accent="green" /></div><h2>Rental terms</h2><SummaryRow label="Rental fee" value="Entered in form" /><SummaryRow label="Security deposit" value="Held by contract" /><SummaryRow label="Rental period" value="Set your dates" /><div className="summary-check">✓ Deposit protection <small>Smart-contract escrow</small></div><p className="summary-help">Your wallet is used to authorize the rental transaction. The deposit stays protected until settlement.</p></aside></div><button className="button-text back-link" onClick={() => onNavigate("rentals")}>← Back to my rentals</button></PageHeader>;
}

function RentalDetailsPage({ contract, rentalId, address, chainId, onNavigate }: { contract: Contract | null; rentalId: string; address: string; chainId: bigint | null; onNavigate: (path: string) => void }) {
  const [rental, setRental] = useState<RentalRecord | null>(null);
  const [refresh, setRefresh] = useState(0);
  return <PageHeader eyebrow="RENTAL RECORD" title={`Rental #${rentalId}`} description="Track the equipment, dates, and deposit settlement in one place."><button className="button-text back-link" onClick={() => onNavigate("rentals")}>← Back to my rentals</button><button className="button-text refresh-button" onClick={() => setRefresh((value) => value + 1)}>↻ Refresh rental</button><RentalLookup key={refresh} contract={contract} initialRentalId={rentalId} detailOnly chainId={chainId} contractAddress={contractAddress} onRentalLoaded={setRental} /><RentalActions contract={contract} rental={rental} address={address} chainId={chainId} onComplete={() => setRefresh((value) => value + 1)} /></PageHeader>;
}

function DisputesPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  async function reload() {
    setLoading(true);
    setError("");
    try { setBookings(await fetchBookings()); }
    catch (reason) { setError(reason instanceof Error && reason.message === "authentication_required" ? "Sign in to view disputes." : "Dispute records could not be loaded."); }
    finally { setLoading(false); }
  }
  useEffect(() => { void reload(); }, []);
  const disputes = bookings.filter((booking) => booking.onchainRentalStatus === "DISPUTED" || booking.onchainRentalStatus === "RESOLVED");
  return <PageHeader eyebrow="RESOLUTION CENTER" title="Something went wrong?" description="Review rentals whose deposit settlement entered a dispute path. Contract state remains authoritative."><section className="content-panel"><PanelHeading title="Dispute records" action="Refresh" onAction={() => void reload()} />{loading ? <div className="empty-state"><strong>Loading dispute records...</strong><p>Reading persisted booking and escrow snapshots.</p></div> : error ? <div className="empty-state"><strong>{error}</strong><button className="outline-button" onClick={() => void reload()}>Try again</button></div> : disputes.length ? <div className="booking-list">{disputes.map((booking) => <article className="booking-row" key={booking.id}><div><span className="card-kicker">Booking #{booking.id}</span><h3>{booking.name}</h3><p>{new Date(booking.startTime).toLocaleString()} – {new Date(booking.endTime).toLocaleString()}</p></div><div><strong>{booking.onchainRentalStatus}</strong><small>{booking.onchainRentalId ? `Rental #${booking.onchainRentalId} · ${booking.onchainVerificationStatus || "UNVERIFIED"}` : "No verified escrow record"}</small>{booking.onchainRentalId && <button className="button-text" onClick={() => onNavigate(`rentals/${booking.onchainRentalId}`)}>Open rental →</button>}</div></article>)}</div> : <EmptyState title="No active disputes" note="Your rentals are currently clear. A persisted escrow snapshot will appear here when a rental enters DISPUTED or RESOLVED state." />}</section></PageHeader>;
}
function ActivityPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  async function reload() {
    setLoading(true);
    setError("");
    try { setBookings(await fetchBookings()); }
    catch (reason) { setError(reason instanceof Error && reason.message === "authentication_required" ? "Sign in to view activity." : "Blockchain activity could not be loaded."); }
    finally { setLoading(false); }
  }
  useEffect(() => { void reload(); }, []);
  const activity = bookings.filter((booking) => Boolean(booking.onchainRentalId || booking.transactionHash));
  return <PageHeader eyebrow="TRUST RECORD" title="Blockchain activity" description="Review only transaction records that EventRent has persisted after backend verification. No activity is fabricated in this view."><section className="content-panel"><PanelHeading title="Verified escrow activity" action="Refresh" onAction={() => void reload()} />{loading ? <div className="empty-state"><strong>Loading activity...</strong><p>Reading verified transaction metadata.</p></div> : error ? <div className="empty-state"><strong>{error}</strong><button className="outline-button" onClick={() => void reload()}>Try again</button></div> : activity.length ? <div className="booking-list">{activity.map((booking) => <article className="booking-row" key={booking.id}><div><span className="card-kicker">Booking #{booking.id} · {booking.onchainVerificationStatus || "UNVERIFIED"}</span><h3>{booking.name}</h3><p>{booking.transactionHash || "Transaction hash unavailable"}</p></div><div><strong>{booking.onchainRentalStatus || "CREATED"}</strong><small>{booking.onchainRentalId ? `Rental #${booking.onchainRentalId} · Chain ${booking.chainId ?? "?"}` : "Pending transaction association"}</small>{booking.onchainRentalId && <button className="button-text" onClick={() => onNavigate(`rentals/${booking.onchainRentalId}`)}>Open rental →</button>}</div></article>)}</div> : <EmptyState title="No verified blockchain activity yet" note="Create an approved escrow rental and let the backend verify its transaction before it appears here." />}</section></PageHeader>;
}
function SettingsPage({ user, address, chainId, walletStatus, onSignOut }: { user: AuthUser | null; address: string; chainId: bigint | null; walletStatus: string; onSignOut: () => void }) {
  return <PageHeader eyebrow="WORKSPACE" title="Account settings" description="Review the authenticated wallet and current local-chain connection. Sensitive credentials and private keys are never shown here."><div className="info-page-grid"><section className="info-card"><span>ACCOUNT</span><h2>Wallet account</h2><p>User ID: {user?.id ?? "Unavailable"}<br />Roles: {user?.roles?.join(", ") || "None selected"}<br />Authentication: MetaMask signature</p></section><section className="info-card"><span>WALLET</span><h2>{address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "Not connected"}</h2><p>{walletStatus}<br />Chain: {chainId?.toString() || "Unavailable"}<br />Contract actions require the configured local escrow and the expected network.</p></section></div><section className="content-panel account-actions"><PanelHeading title="Session" /><p className="auth-intro">Signing out clears the server session. Reconnect and sign a fresh wallet challenge to authenticate again.</p><button className="button-primary" onClick={onSignOut}>Sign out</button></section></PageHeader>;
}
function HowItWorksPage() { return <PageHeader eyebrow="HOW IT WORKS" title="A normal rental, with a clearer deposit." description="The contract handles the deposit rules underneath. You can focus on the equipment and the event."><div className="info-page-grid">{["Choose equipment", "Agree the rental", "Protect the deposit", "Return and settle"].map((title, index) => <article className="info-card" key={title}><span>0{index + 1}</span><h2>{title}</h2><p>{["Browse the gear your event needs.", "Set the renter, dates, rental fee, and deposit.", "The security deposit stays in escrow until settlement.", "The right person can approve, dispute, or withdraw according to the rental state."][index]}</p></article>)}</div></PageHeader>; }
function TrustPage() { return <PageHeader eyebrow="TRUST & TRANSPARENCY" title="What is protected, and what is not." description="EventRent makes the financial rules visible without pretending a smart contract can inspect physical equipment."><div className="trust-grid"><section className="info-card"><h2>Protected by the contract</h2><p>Rental terms, deposit custody, lifecycle transitions, dispute settlement, and claimable withdrawals are controlled by RentalEscrow.</p></section><section className="info-card"><h2>Still agreed by people</h2><p>Equipment condition, handover, damage evidence, and the rental fee are real-world responsibilities. The current contract escrows only the security deposit.</p></section></div></PageHeader>; }

type OwnerSection = "overview" | "equipment" | "add-equipment" | "bookings" | "returns";

function OwnerWorkspacePage({ contract, chainId, onNavigate, section }: { contract: Contract | null; chainId: bigint | null; onNavigate: (path: string) => void; section: OwnerSection }) {
  const [listings, setListings] = useState<Listing[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [editingListing, setEditingListing] = useState<Listing | null>(null);

  async function reload() {
    setLoading(true);
    setError("");
    try {
      const [nextListings, nextBookings] = await Promise.all([fetchMyListings(), fetchBookings()]);
      setListings(nextListings);
      setBookings(nextBookings);
    } catch (reason) {
      setError(reason instanceof Error && reason.message === "authentication_required" ? "Sign in to load your owner workspace." : "The owner workspace could not be loaded. Try again.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void reload(); }, []);

  async function decide(bookingId: number, status: "APPROVED" | "REJECTED") {
    setMessage("");
    try {
      await updateBookingStatus(bookingId, status);
      setMessage(status === "APPROVED" ? "Booking approved." : "Booking declined.");
      await reload();
      if (status === "APPROVED") onNavigate("owner/rentals");
    } catch (reason) {
      setMessage(reason instanceof Error && reason.message === "dates_unavailable" ? "Those dates conflict with another approved booking." : "The booking decision could not be saved. Refresh and try again.");
    }
  }

  async function handleListingUpdated() {
    await reload();
    setEditingListing(null);
    setMessage("Listing updated successfully.");
  }

  const pending = bookings.filter((booking) => booking.status === "REQUESTED" && !booking.onchainRentalId);
  const returns = bookings.filter((booking) => booking.onchainRentalStatus === "RETURNED" || booking.onchainRentalStatus === "DISPUTED" || booking.onchainRentalStatus === "RESOLVED");

  function bookingRow(booking: Booking, actions = true) {
    return <article className="booking-row" key={booking.id}><div><span className="card-kicker">Booking #{booking.id} · {booking.status}</span><h3>{booking.name}</h3><p>{new Date(booking.startTime).toLocaleString()} – {new Date(booking.endTime).toLocaleString()}</p><small>{booking.onchainRentalId ? `Rental #${booking.onchainRentalId} · ${booking.onchainVerificationStatus || "UNVERIFIED"} · ${booking.onchainRentalStatus || "CREATED"}` : "Off-chain booking · no escrow record yet"}</small></div>{actions && booking.status === "REQUESTED" ? <div className="row-actions"><button className="outline-button" onClick={() => void decide(booking.id, "REJECTED")}>Decline</button><button className="button-primary" onClick={() => void decide(booking.id, "APPROVED")}>Approve</button></div> : booking.status === "APPROVED" && !booking.onchainRentalId ? <EscrowBookingAction contract={contract} chainId={chainId} booking={booking} onComplete={() => void reload()} /> : booking.onchainRentalId ? <button className="button-text" onClick={() => onNavigate(`rentals/${booking.onchainRentalId}`)}>Open escrow →</button> : null}</article>;
  }

  function listingContent() {
    if (loading) return <div className="empty-state"><strong>Loading your listings...</strong><p>Reading your persistent marketplace records.</p></div>;
    if (editingListing) return <ListingEditForm listing={editingListing} onCancel={() => setEditingListing(null)} onComplete={handleListingUpdated} />;
    if (!listings.length) return <EmptyState title="No listings yet" note="Add equipment to publish your first persistent marketplace listing." action="Add equipment" onAction={() => onNavigate("owner/add-equipment")} />;
    return <div className="booking-list">{listings.map((listing) => <article className="booking-row" key={listing.id}><div><span className="card-kicker">{listing.category} · {listing.serialId ? "SERIAL VALIDATED" : "SERIAL MISSING"}</span><h3>{listing.name}</h3><p>{listing.dailyFee} ETH/day · {listing.deposit} ETH deposit</p><small>{listing.serialId || "Add a serial ID before publishing"}</small></div><div className="row-actions"><strong>{listing.active ? "VISIBLE" : "PAUSED"}</strong><button className="outline-button listing-edit-button" onClick={() => setEditingListing(listing)}>Edit</button></div></article>)}</div>;
  }

  let content: ReactNode;
  if (error) content = <div className="empty-state"><strong>{error}</strong><button className="outline-button" onClick={() => void reload()}>Try again</button></div>;
  else if (section === "add-equipment") content = <ListingForm onComplete={() => onNavigate("owner/equipment")} />;
  else if (section === "equipment") content = <section className="content-panel"><PanelHeading title="My equipment" action="Add listing" onAction={() => onNavigate("owner/add-equipment")} />{listingContent()}</section>;
  else if (section === "bookings") content = <section className="content-panel"><PanelHeading title="All booking requests" action="Refresh" onAction={() => void reload()} />{loading ? <div className="empty-state"><strong>Loading all booking requests...</strong></div> : bookings.length ? <div className="booking-list">{bookings.map((booking) => bookingRow(booking))}</div> : <EmptyState title="No booking requests" note="Renter requests will appear here for your equipment." />}</section>;
  else if (section === "returns") content = <section className="content-panel"><PanelHeading title="Returns and settlement" action="Refresh" onAction={() => void reload()} />{loading ? <div className="empty-state"><strong>Loading return records...</strong></div> : returns.length ? <div className="booking-list">{returns.map((booking) => bookingRow(booking, false))}</div> : <EmptyState title="No returns to review" note="On-chain returns and dispute states will appear here when the contract reports them." />}</section>;
  else content = <div className="home-columns"><section className="content-panel"><PanelHeading title="My equipment" action="View all" onAction={() => onNavigate("owner/equipment")} />{listingContent()}</section><section className="content-panel"><PanelHeading title="Incoming bookings" action="View requests" onAction={() => onNavigate("owner/rentals")} />{loading ? <div className="empty-state"><strong>Loading booking requests...</strong></div> : pending.length ? <div className="booking-list">{pending.slice(0, 3).map((booking) => bookingRow(booking))}</div> : <EmptyState title="No pending booking requests" note="New renter requests will appear here before escrow is created." />}</section></div>;

  const titles: Record<OwnerSection, string> = { overview: "Put your equipment to work.", equipment: "My equipment", "add-equipment": "Add equipment", bookings: "Incoming bookings", returns: "Returns and settlement" };
  return <PageHeader eyebrow={section === "overview" ? "OWNER DASHBOARD" : "OWNER WORKSPACE"} title={titles[section]} description="Manage persistent listings and approve booking requests before any blockchain escrow is created."><section className="owner-callout"><div><span className="eyebrow">OWNER WORKSPACE</span><h2>{section === "add-equipment" ? "Publish the next useful item." : "List equipment for the next event."}</h2><p>Publishing here stores an off-chain listing; it does not create or fund a smart-contract rental.</p>{section !== "add-equipment" && <button className="button-primary" onClick={() => onNavigate("owner/add-equipment")}>Add equipment →</button>}</div><EquipmentVisual type="projector" accent="gold" /></section>{message && <p className="message success">{message}</p>}{content}</PageHeader>;
}

function OwnerPage({ contract, chainId, onNavigate }: { contract: Contract | null; chainId: bigint | null; onNavigate: (path: string) => void }) {
  const [listings, setListings] = useState<Listing[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [editingListing, setEditingListing] = useState<Listing | null>(null);
  const addEquipment = location.hash.includes("add-equipment");
  async function reload() {
    setLoading(true);
    try {
      const [nextListings, nextBookings] = await Promise.all([fetchMyListings(), fetchBookings()]);
      setListings(nextListings);
      setBookings(nextBookings);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void reload().catch(() => setMessage("Sign in to load your owner workspace.")); }, []);
  async function decide(bookingId: number, status: "APPROVED" | "REJECTED") {
    try { await updateBookingStatus(bookingId, status); await reload(); } catch (error) { setMessage(error instanceof Error && error.message === "dates_unavailable" ? "Those dates conflict with another approved booking." : "The booking decision could not be saved."); }
  }
  async function handleListingUpdated() {
    try {
      await reload();
      setEditingListing(null);
      setMessage("Listing updated successfully.");
    } catch {
      setEditingListing(null);
      setMessage("Listing was saved, but the owner list could not be refreshed. Reload the page to see the change.");
    }
  }
  return <PageHeader eyebrow="OWNER DASHBOARD" title="Put your equipment to work." description="Manage persistent listings and approve booking requests before any blockchain escrow is created."><section className="owner-callout"><div><span className="eyebrow">OWNER WORKSPACE</span><h2>List equipment for the next event.</h2><p>One EventRent account can rent equipment and list equipment. Publishing here stores an off-chain listing; it does not create or fund a smart-contract rental.</p><button className="button-primary" onClick={() => { setEditingListing(null); onNavigate("owner/add-equipment"); }}>Add equipment →</button></div><EquipmentVisual type="projector" accent="gold" /></section>{message && <p className={`message ${message.includes("successfully") ? "success" : "error"}`}>{message}</p>}{addEquipment ? <ListingForm onComplete={() => onNavigate("owner")} /> : <div className="home-columns"><section className="content-panel"><PanelHeading title="My equipment" action="Add listing" onAction={() => { setEditingListing(null); onNavigate("owner/add-equipment"); }} />{loading ? <p>Loading your listings...</p> : editingListing ? <ListingEditForm listing={editingListing} onCancel={() => setEditingListing(null)} onComplete={handleListingUpdated} /> : listings.length ? <div className="booking-list">{listings.map((listing) => <article className="booking-row" key={listing.id}><div><span className="card-kicker">{listing.category}</span><h3>{listing.name}</h3><p>{listing.dailyFee} ETH/day · {listing.deposit} ETH deposit</p></div><div className="row-actions"><strong>{listing.active ? "ACTIVE" : "PAUSED"}</strong><button className="outline-button listing-edit-button" onClick={() => { setMessage(""); setEditingListing(listing); }}>Edit</button></div></article>)}</div> : <EmptyState title="No listings yet" note="Add equipment to publish your first persistent marketplace listing." />}</section><section className="content-panel"><PanelHeading title="Incoming bookings" action="Refresh" onAction={() => void reload()} />{bookings.length ? <div className="booking-list">{bookings.map((booking) => <article className="booking-row" key={booking.id}><div><span className="card-kicker">Booking #{booking.id} · {booking.status}</span><h3>{booking.name}</h3><p>{new Date(booking.startTime).toLocaleString()} – {new Date(booking.endTime).toLocaleString()}</p></div>{booking.status === "REQUESTED" ? <div className="row-actions"><button className="outline-button" onClick={() => void decide(booking.id, "REJECTED")}>Reject</button><button className="button-primary" onClick={() => void decide(booking.id, "APPROVED")}>Approve</button></div> : booking.status === "APPROVED" && !booking.onchainRentalId ? <EscrowBookingAction contract={contract} chainId={chainId} booking={booking} onComplete={() => void reload()} /> : <small>{booking.onchainRentalId ? `Rental #${booking.onchainRentalId} · ${booking.onchainRentalStatus || "CREATED"} · ${booking.onchainVerificationStatus || "VERIFIED"}` : "Closed request"}</small>}</article>)}</div> : <EmptyState title="No booking requests yet" note="New renter requests will appear here." />}</section></div>}</PageHeader>;
}

function EscrowBookingAction({ contract, chainId, booking, onComplete }: { contract: Contract | null; chainId: bigint | null; booking: Booking; onComplete: () => void }) {
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [pendingRecord, setPendingRecord] = useState<{ rentalId: string; transactionHash: string } | null>(null);
  const [recording, setRecording] = useState(false);

  async function recordConfirmedEscrow(rentalId: string, transactionHash: string) {
    if (chainId !== HARDHAT_CHAIN_ID) {
      setMessage("Switch back to Hardhat Local before recording the confirmed escrow.");
      return;
    }
    setRecording(true);
    setMessage("");
    try {
      await recordOnchainRental(booking.id, rentalId, transactionHash, Number(chainId));
      setPendingRecord(null);
      setMessage(`Rental #${rentalId} recorded. The renter must fund the deposit separately.`);
      onComplete();
    } catch (error) {
      const code = error instanceof Error ? error.message : "request_failed";
      if (code === "insufficient_confirmations") {
        setPendingRecord({ rentalId, transactionHash });
        setMessage("The transaction is confirmed but needs more block confirmations. Wait briefly, then record it again; no duplicate transaction was sent.");
      } else {
        setMessage(`The confirmed escrow could not be recorded: ${code}. No duplicate transaction was sent.`);
      }
    } finally {
      setRecording(false);
    }
  }

  async function createEscrow() {
    if (!contract || chainId !== HARDHAT_CHAIN_ID) { setMessage("Connect the owner wallet on Hardhat Local before creating escrow."); return; }
    if (!booking.renterWalletAddress || !booking.dailyFee || !booking.deposit) { setMessage("The renter must sign in with MetaMask before this booking can use escrow."); return; }
    setWorking(true); setMessage("");
    try {
      const transaction = await contract.createRental(`listing-${booking.listingId}`, booking.name, booking.renterWalletAddress, parseEther(booking.dailyFee), parseEther(booking.deposit), BigInt(Math.floor(new Date(booking.startTime).getTime() / 1000)), BigInt(Math.floor(new Date(booking.endTime).getTime() / 1000)));
      const receipt = await transaction.wait();
      const event = receipt.logs.map((log: { topics: string[]; data: string }) => { try { return contract.interface.parseLog(log); } catch { return null; } }).find((parsed: { name?: string; args?: { rentalId?: bigint } } | null) => parsed?.name === "RentalCreated");
      const rentalId = event?.args?.rentalId?.toString();
      if (!rentalId) throw new Error("rental_id_not_found");
      await recordConfirmedEscrow(rentalId, transaction.hash);
    } catch (error) {
      setMessage(explainWalletError(error));
    } finally { setWorking(false); }
  }
  return <div>{pendingRecord?.rentalId ? <button className="button-primary" disabled={recording} onClick={() => void recordConfirmedEscrow(pendingRecord.rentalId, pendingRecord.transactionHash)}>{recording ? "Recording..." : "Record confirmed escrow"}</button> : <button className="button-primary" disabled={working} onClick={() => void createEscrow()}>{working ? "Waiting for confirmation..." : "Create escrow"}</button>}{message && <small>{message}</small>}</div>;
}
function LegacyListingForm({ onComplete }: { onComplete: () => void }) {
  const [values, setValues] = useState({ name: "", category: "Sound", description: "", condition: "Good condition", dailyFee: "", deposit: "", location: "Local pickup", pickupDetails: "Pickup details are arranged with the owner." });
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);
  async function submit(event: FormEvent) { event.preventDefault(); setWorking(true); setMessage(""); try { await createListing(values); setMessage("Listing published successfully."); onComplete(); } catch (error) { const code = error instanceof Error ? error.message : "request_failed"; setMessage(code === "authentication_required" ? "Sign in before publishing a listing." : code === "owner_role_required" ? "Choose the owner workspace before publishing." : code === "invalid_listing" ? "Add valid values for every field, including positive ETH amounts." : "Listing could not be saved. Try again."); } finally { setWorking(false); } }
  return <section className="content-panel listing-form"><h2>Add equipment</h2><p className="auth-intro">This creates a persistent off-chain listing. It does not deploy or fund a smart-contract rental.</p><form className="form-grid" onSubmit={submit}>{(["name", "description", "condition", "dailyFee", "deposit", "location", "pickupDetails"] as const).map((field) => <label key={field}>{field === "dailyFee" ? "Daily fee (ETH)" : field === "deposit" ? "Security deposit (ETH)" : field.replace(/[A-Z]/g, (letter) => ` ${letter}`).replace(/^./, (letter) => letter.toUpperCase())}<input required value={values[field]} onChange={(event) => setValues({ ...values, [field]: event.target.value })} /></label>)}<label>Category<select value={values.category} onChange={(event) => setValues({ ...values, category: event.target.value })}><option>Sound</option><option>Projection</option><option>Capture</option><option>Lighting</option><option>Accessories</option></select></label><button className="button-primary" type="submit" disabled={working}>{working ? "Publishing..." : "Publish listing"}</button></form>{message && <p className={`message ${message.includes("successfully") ? "success" : "error"}`}>{message}</p>}</section>;
}

function LegacyListingEditForm({ listing, onCancel, onComplete }: { listing: Listing; onCancel: () => void; onComplete: () => Promise<void> }) {
  const [values, setValues] = useState({ name: listing.name, category: listing.category, description: listing.description, imageUrl: listing.imageUrl || "", condition: listing.condition, dailyFee: listing.dailyFee, deposit: listing.deposit, location: listing.location, pickupDetails: listing.pickupDetails, active: Boolean(listing.active) });
  const [state, setState] = useState<"idle" | "working" | "error">("idle");
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!values.name.trim() || !values.category.trim() || !values.description.trim() || !values.condition.trim() || !values.dailyFee.trim() || !values.deposit.trim() || !values.location.trim() || !values.pickupDetails.trim()) {
      setState("error");
      setMessage("Complete all listing fields, including positive ETH amounts.");
      return;
    }
    setState("working");
    setMessage("");
    try {
      await updateListing(listing.id, { name: values.name.trim(), category: values.category.trim(), description: values.description.trim(), imageUrl: values.imageUrl.trim(), condition: values.condition.trim(), dailyFee: values.dailyFee.trim(), deposit: values.deposit.trim(), location: values.location.trim(), pickupDetails: values.pickupDetails.trim(), active: values.active });
      await onComplete();
    } catch (error) {
      setState("error");
      const code = error instanceof Error ? error.message : "request_failed";
      setMessage(code === "authentication_required" ? "Sign in before editing a listing." : code === "listing_owner_required" ? "You can only edit your own listing." : "Listing changes could not be saved. Try again.");
    }
  }

  return <section className="content-panel listing-form"><div className="panel-heading"><h2>Edit equipment</h2><button className="button-text" type="button" onClick={onCancel}>Cancel</button></div><p className="auth-intro">Update the public listing terms and availability. Saving uses the owner-only backend endpoint.</p><form className="form-grid" onSubmit={submit}><label>Name<input required value={values.name} onChange={(event) => setValues({ ...values, name: event.target.value })} /></label><label>Category<select value={values.category} onChange={(event) => setValues({ ...values, category: event.target.value })}><option>Sound</option><option>Projection</option><option>Capture</option><option>Lighting</option><option>Accessories</option></select></label><label className="full-width">Description<textarea required value={values.description} onChange={(event) => setValues({ ...values, description: event.target.value })} /></label><label>Condition<input required value={values.condition} onChange={(event) => setValues({ ...values, condition: event.target.value })} /></label><label>Image URL (optional)<input value={values.imageUrl} onChange={(event) => setValues({ ...values, imageUrl: event.target.value })} /></label><label>Daily fee (ETH)<input required inputMode="decimal" value={values.dailyFee} onChange={(event) => setValues({ ...values, dailyFee: event.target.value })} /></label><label>Security deposit (ETH)<input required inputMode="decimal" value={values.deposit} onChange={(event) => setValues({ ...values, deposit: event.target.value })} /></label><label>Location<input required value={values.location} onChange={(event) => setValues({ ...values, location: event.target.value })} /></label><label>Pickup details<input required value={values.pickupDetails} onChange={(event) => setValues({ ...values, pickupDetails: event.target.value })} /></label><label className="full-width listing-active-field"><input type="checkbox" checked={values.active} onChange={(event) => setValues({ ...values, active: event.target.checked })} /> Available in the marketplace</label><div className="row-actions"><button className="button-primary" type="submit" disabled={state === "working"}>{state === "working" ? "Saving changes..." : "Save changes"}</button><button className="outline-button listing-cancel-button" type="button" onClick={onCancel} disabled={state === "working"}>Cancel</button></div></form>{message && <p className={`message ${state === "error" ? "error" : "success"}`}>{message}</p>}</section>;
}
function EmptyPage({ eyebrow, title, description, note }: { eyebrow: string; title: string; description: string; note: string }) { return <PageHeader eyebrow={eyebrow} title={title} description={description}><section className="content-panel"><EmptyState title={title} note={note} /></section></PageHeader>; }
function PageHeader({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children: ReactNode }) { return <div className="page-header"><div className="page-title"><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{children}</div>; }
function PanelHeading({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) { return <div className="panel-heading"><h2>{title}</h2>{action && <button className="button-text" onClick={onAction}>{action} →</button>}</div>; }
function EmptyState({ title, note, action, onAction }: { title: string; note: string; action?: string; onAction?: () => void }) { return <div className="empty-state"><span className="empty-icon">⌁</span><strong>{title}</strong><p>{note}</p>{action && <button className="outline-button" onClick={onAction}>{action}</button>}</div>; }
function SummaryRow({ label, value }: { label: string; value: string }) { return <div className="summary-row"><span>{label}</span><strong>{value}</strong></div>; }
function ValueCard({ title, text }: { title: string; text: string }) { return <article className="value-card"><span className="value-rule" /><h2>{title}</h2><p>{text}</p></article>; }
function ListingPlaceholder({ type }: { type: string }) { return <div className="listing-placeholder"><EquipmentVisual type={type} accent="coral" /><span>Image pending</span></div>; }
function EquipmentVisual({ type, accent }: { type: string; accent: string }) { return <div className={`equipment-visual ${type} ${accent}`} aria-hidden="true"><span className="visual-shape" /><span className="visual-detail" /></div>; }
