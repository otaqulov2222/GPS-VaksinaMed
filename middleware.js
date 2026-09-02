/** Maxfiy fayllarni ochiq internetdan yopish (Vercel Edge). */
const BLOCK = [
  /^\/app\.py$/i,
  /^\/vm_server\.py$/i,
  /^\/vm_runtime\.py$/i,
  /^\/gps_sync\.py$/i,
  /^\/hr_api\.py$/i,
  /^\/office-seed\.json$/i,
  /^\/render\.yaml$/i,
  /^\/Procfile$/i,
  /^\/start\.bat$/i,
  /^\/requirements\.txt$/i,
  /^\/runtime\.txt$/i,
  /^\/\.env/i,
  /^\/data\//i,
  /^\/scripts\//i,
];

export default function middleware(request) {
  const path = new URL(request.url).pathname;
  if (BLOCK.some((re) => re.test(path))) {
    return new Response("Not Found", { status: 404 });
  }
  return fetch(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|logo/).*)"],
};
