/** .html manzilni toza URL ga almashtirish (nginx statik xizmat qilsa ham). */
(function () {
    var path = (location.pathname || '').replace(/\\/g, '/');
    var m = path.match(/^\/([^/?#]+)\.html$/i);
    if (!m) return;
    var map = {
        index: '/',
        live: '/live',
        fuel: '/fuel',
        attendance: '/attendance',
        admin: '/admin',
        driver: '/driver',
        profile: '/profile',
        login: '/login',
    };
    var dest = map[m[1].toLowerCase()];
    if (dest != null) location.replace(dest + location.search + location.hash);
})();
