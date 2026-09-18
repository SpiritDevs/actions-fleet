# Host the fleet relay on Cloudflare

Serve the dashboard on Vercel and use Cloudflare Workers with Durable Objects for the hosted fleet relay; browsers and Mac/Linux host agents connect to that relay, with host connections initiated outbound. This provides shared live monitoring and remote control without a separate VPS or per-machine Cloudflare Tunnels, while GitHub Actions retains job assignment and workflow authority. The tradeoff is Cloudflare platform dependence and metered relay/storage usage; durable history and reconnect recovery are application responsibilities.
