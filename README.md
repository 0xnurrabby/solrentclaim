# Solana Rent Claimer & Wallet Cleaner (`solrentclaim`)

> Scan empty accounts. Reclaim locked rent. Sweep remaining SOL. 100% local, private, and fee-free.

A fast, production-grade local web utility designed to scan multiple Solana wallets, close empty SPL and Token-2022 accounts to reclaim locked rent (~0.002039 SOL per account), and sweep all leftover SOL directly to your designated main wallet.

---

## Key Features

- ⚡ **Atomic Single-Transaction Cleaner**: Closes empty token accounts and sweeps native SOL in **a single atomic transaction** per wallet (~1.5s per wallet).
- 🛡️ **Direct Fee Payer Sponsoring**: Your Fee Sender wallet sponsors the standard network fee (~0.000005 SOL / ~$0.00075) directly. Target wallets require **0 SOL** upfront, and **zero kickstart** is ever trapped.
- 🗂️ **Key Categorization & One-Click Export**: Automatically partitions wallets into **Eligible** (holding $\ge$ 0.0019 SOL rent) and **Ineligible / Zero Rent** groups. One-click **Copy Keys**, **Copy Addresses**, and **Download .txt**.
- 🔍 **High-Speed Bulk Scanning**: Scans hundreds of wallets in seconds with chunked native balance lookups and real-time Server-Sent Events (SSE) streaming progress.
- 🔒 **100% Local & Non-Custodial**: Binds strictly to `127.0.0.1:4000`. Keys and seed phrases never leave your machine. Zero telemetry, zero analytics, zero external dependencies, 0% service fee.
- 🔑 **Multi-Format Secret Parsing**: Accepts 12/24-word BIP-39 seed phrases, base58 private keys, and JSON byte arrays (`[1, 2, ...]`).

---

## Quickstart

### Prerequisites
- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- npm

### Installation & Launch

```bash
# 1. Clone the repository
git clone https://github.com/0xnurrabby/solrentclaim.git
cd solrentclaim

# 2. Install dependencies
npm install

# 3. Start the application
npm start
```

Open your browser and navigate to:
```
http://127.0.0.1:4000
```

---

## How It Works

### The 3 Roles

1. **Target Wallets**: The wallets whose keys you paste into the app. These often hold empty SPL or Token-2022 token accounts with locked rent (~0.00203928 SOL each).
2. **Main Wallet**: Your primary destination address (e.g. Ledger, Phantom, or cold storage). 100% of reclaimed rent and leftover SOL is sent directly here.
3. **Fee Sender Wallet**: A dedicated wallet pre-funded with a tiny balance (e.g. 0.005 – 0.01 SOL / ~$1). It acts as the `feePayer` for transactions, sponsoring the network gas fee.

### Single Atomic Transaction Architecture

Unlike naive scripts that transfer kickstart SOL to empty target wallets (which often fail Solana runtime rent-exemption checks or get stuck), `solrentclaim` uses **Direct Fee Sponsoring**:

```
Transaction:
├── Fee Payer: Fee Sender Wallet (pays ~0.000005 SOL network fee)
├── Signers: [Fee Sender, Target Wallet]
├── Instruction 1: CloseAccount(tokenAccount, destination: MainWallet, authority: TargetWallet)
│   └── Rent refund (~0.002039 SOL) credited DIRECTLY to Main Wallet
└── Instruction 2: SystemProgram.transfer(from: TargetWallet, to: MainWallet, lamports: TargetBalance)
    └── 100% of Target's native SOL transferred DIRECTLY to Main Wallet
```

- **Target wallet ends at exactly 0 lamports** (cleanly purged by the Solana runtime).
- **Zero kickstart sent, zero kickstart trapped.**
- Network fee for 100 wallets is only **~0.0005 SOL (~$0.06 total)**!

---

## Key Categorization & Eligibility Filter

When scanning large lists of wallets, `solrentclaim` automatically separates your keys into two cards:
- **Eligible Keys (Rent $\ge$ 0.0019 SOL)**: Wallets holding empty accounts ready for refund.
- **Ineligible / Zero Rent (< 0.0019 SOL)**: Wallets with no empty accounts or zero rent.

Each card features:
- **Copy Keys**: Copies all private keys/seeds in that group to your clipboard in 1 click.
- **Copy Addresses**: Copies all public addresses.
- **Download .txt**: Saves the list as a clean `.txt` file.
- **Threshold Controller**: Quickly switch between `0.0019`, `0.0020`, or `> 0` SOL threshold in real-time.

---

## Security & Operational Commitments

- **Localhost Only**: Binds strictly to `127.0.0.1` and blocks non-localhost `Host` headers.
- **Never Deploy to Public Clouds**: Do NOT deploy this tool to public hosting providers (Vercel, Render, AWS, etc.). It is designed strictly for local use.
- **Zero Cut / Zero Telemetry**: 0% fee. No hidden transfers, no commissions, no tracking scripts.
- **Safety First**: Token accounts with non-zero token balances, frozen states, or unknown authorities are automatically skipped.

---

## Configuration (Optional)

Create a `.env` file in the root directory:

```env
PORT=4000
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
```

*Tip: For fastest scans across 100+ wallets without rate limits, provide a free RPC endpoint from [Helius](https://helius.dev), [QuickNode](https://quicknode.com), or [Alchemy](https://alchemy.com).*

---

## License

MIT License. Free to use, modify, and distribute for personal and commercial Solana wallet maintenance.
