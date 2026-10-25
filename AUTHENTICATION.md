# EventRent wallet authentication

EventRent uses MetaMask as its only login method. There is no Gmail, email/password account, email verification, password reset, SMTP setup, or password data in the running application.

## Local setup

Use separate PowerShell terminals from the project root:

### 1. Start Hardhat

```powershell
npx hardhat node
```

Keep this process running. It exposes the local JSON-RPC endpoint at
`http://127.0.0.1:8545` with chain ID `31337` and disposable test accounts.

### 2. Deploy the local escrow

```powershell
$env:RENTAL_ESCROW_DEPLOY="1"
npx hardhat run scripts/deploy.ts --network localhost
```

Copy the printed `RentalEscrow` address into `frontend/.env.local`:

```text
VITE_RENTAL_ESCROW_ADDRESS=0x...
VITE_HARDHAT_CHAIN_ID=31337
```

The deploy script does not overwrite an existing configured address. If the
Hardhat node is restarted, deploy again and update the address because local
chain state is reset.

### 3. Start the backend and frontend

```powershell
$env:APP_ORIGIN="http://localhost:5173"
$env:BLOCKCHAIN_RPC_URL="http://127.0.0.1:8545"
$env:BLOCKCHAIN_CHAIN_ID="31337"
$env:RENTAL_ESCROW_ADDRESS="0x..."
npm run backend
```

In another terminal:

```powershell
npm run dev --prefix frontend
```

Open `http://localhost:5173`.

## MetaMask sign-in flow

1. Install MetaMask in the browser.
2. Import one of the disposable private keys printed by `npx hardhat node`.
3. Click **Connect MetaMask** on the first page.
4. EventRent automatically adds or switches MetaMask to **Hardhat Local** (`31337`).
5. Approve the account connection.
6. Approve the free signed login message. Signing proves wallet ownership and does
   not send a blockchain transaction.
7. Choose either the renter or owner workspace when prompted.

The backend issues a short-lived, single-use, origin-bound nonce. MetaMask signs
that nonce, the backend verifies the signature, and the backend creates an
HttpOnly session cookie tied to the wallet address. Changing accounts, changing
networks, or disconnecting MetaMask clears the authenticated session in the UI.

## Marketplace behavior

The marketplace starts empty. Owners create persistent listings from the owner
workspace and must provide a unique serial ID for each physical item. They can
also upload a PNG, JPG, or WebP item image; the frontend compresses it locally
and stores it with the listing so renters see the image and serial validation
status in the marketplace. No sample catalogue is inserted into a new database.
A migration also removes the old `demo-owner@eventrent.local` sample owner and
its listings from an existing local database the next time it starts.

Protected marketplace actions use the wallet-authenticated session and the
selected renter/owner capability. Rental escrow transactions still require
MetaMask on Hardhat Local and the deployed `RentalEscrow` address.

## Environment reference

The root [`.env.example`](./.env.example) documents backend variables. The
frontend reads `frontend/.env.local` through Vite. Never put backend secrets in
`VITE_*` variables.
