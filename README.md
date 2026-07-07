# Cryptvest

A crypto staking platform with a shared Next.js frontend (user app + role-gated admin panel) and a Node.js/Express backend.

## Tech Stack

- **Frontend:** Next.js 14 (App Router), TypeScript, Tailwind CSS
- **Backend:** Node.js, Express, TypeScript
- **Database:** PostgreSQL, Prisma
- **Auth:** JWT, bcrypt, TOTP for admin
- **Blockchain:** BlockCypher (BTC testnet), Ethers.js (USDT ERC-20 on Sepolia)
- **Notifications:** Resend

## Monorepo Structure

```
cryptvest/
  apps/
    web/          # Next.js user + admin app
    api/          # Express backend
  packages/
    db/           # Prisma schema + client
    shared/       # Enums, types, constants
```

## Getting Started

1. Install dependencies:
   ```bash
   pnpm install
   ```
2. Copy `.env.example` files and fill in your credentials:
   ```bash
   cp .env.example .env
   cp apps/api/.env.example apps/api/.env
   cp apps/web/.env.example apps/web/.env.local
   cp packages/db/.env.example packages/db/.env
   ```
3. Set up the database:
   ```bash
   pnpm db:push
   ```
4. Run the dev servers:
   ```bash
   pnpm dev
   ```
   - Web app: http://localhost:3000
   - API: http://localhost:4000

## Build

```bash
pnpm build
```

## Next Steps

- Implement full auth flow (email verification, admin 2FA)
- KYC submission + review queue
- Deposit address generation + blockchain polling
- Stake plans CRUD + user staking + daily accrual cron
- Withdrawal request + admin approval + payout job
- Admin reporting (liability reconciliation)
- Email notifications
- Wallet hardening before mainnet
