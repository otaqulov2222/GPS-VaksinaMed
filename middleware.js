/** Maxfiy fayllarni ochiq internetdan yopish (Vercel Edge). */
const BLOCK = [
  /^\/server\.py$/i,
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
  const path = request.nextUrl.pathname;
  if (BLOCK.some((re) => re.test(path))) {
    return new Response("Not Found", { status: 404 });
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|logo/).*)"],
};
