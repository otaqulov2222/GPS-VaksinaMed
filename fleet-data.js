'use strict';
/* Bitta manba: barcha mashina va haydovchilar (VHK, Boshqaruv, Admin) */

const FLEET_DRIVERS = [
  { car: '01 269 KMA', fullName: 'Хўжамов Хасан', shortName: 'Хасан', color: '#3498db',
    routes: 'Чиланзор, Учтепа',
    pharmacies: 'Ширин,Алгоритм,Алгоритм-Гулистон,Катта-қани,Андалус,Чилонзор-19,Оқтепа,Новза,Чилонзор Торговий,Гор Больница-16,Ал Хоразмий,Парламент' },
  { car: '01 949 AKA', fullName: 'Ибрагимов Дилшод', shortName: 'Дилшод', color: '#e67e22',
    routes: 'Мирабад, Юнусобод',
    pharmacies: 'Саракулка,Алфраганус,Баку,Узбум,Фуркат боги,Госпитальний,Ц-1,Полевой,Кумарик,Аския,Бобур,Кушбеги' },
  { car: '01 302 DNA', fullName: 'Абдумаликов Йигитали', shortName: 'Йигитали', color: '#34495e',
    routes: 'Юнусобод, Алмазар',
    pharmacies: '16-Йиллик,Ахмад Дониш,Кара Камыш,Кара Камыш Тансикбоев,Мега Планет,Чинобод,Шахристанский,Юнусабад-15,Юнусабад-18,Юнусабад-4,Юнусабад-7,Юнусобод Петушок,Юнусобод Хуросон' },
  { car: '01 255 HMA', fullName: 'Мустафақулов Мухриддин', shortName: 'Мухриддин', color: '#e74c3c',
    routes: 'Сергели, Янгихаёт',
    pharmacies: 'Серили-1,Дўстлик-1,Спутник-5,9-худуд,Янги дархон,Сергили-7,Элет маркет,Сергили-7 бозорчаси,Сергели-8,Спутник-7,Сергели-8 корзинка,Серили-4' },
  { car: '01 205 HMA', fullName: 'Туробов Аваз', shortName: 'Аваз', color: '#27ae60',
    routes: 'М.Улугбек, Яккасарой',
    pharmacies: 'Учхоз,Учхоз макро,Кибрай фарход мадад,Поселка,Салар,М.Улугбек Налоговый,Ит Парк,Дархон,Кардиология,Алайский Ардус,Паркент' },
  { car: '01 043 KMA', fullName: 'Саидов Жавохир', shortName: 'Жавохир', color: '#9b59b6',
    routes: 'Яшнабад, Янгихаёт',
    pharmacies: 'Панельный,Авиясозлар-2,Кадешева бозори,Тапович,Антей,Тузел,Лисунова,Дубовий,Циалковиский,40-Лет,Карзинка лисунова,Тасселмаш' },
  { car: '01 931 PJA', fullName: 'Нуралиев Тимур', shortName: 'Тимур', color: '#16a085',
    routes: 'Шайхантахур, Учтепа',
    pharmacies: 'Гор-1,Гор-2,Фарм люкс,Беш қайроғоч,Летературний,Тош-1,Тош-2,Белтепа,Ибнсино,Назарбек,Тарнов,Урикзор' },
  { car: '01 083 XJA', fullName: 'Қозоқов Зухриддин', shortName: 'Зухриддин', color: '#e67e22', routes: '—', pharmacies: '' },
  { car: '01 382 NMA', fullName: 'Наханбоев Умид', shortName: 'Умид', color: '#1abc9c', routes: '—', pharmacies: '' },
  { car: '01 282 BMA', fullName: 'Ахтамов Боймурод', shortName: 'Боймурод', color: '#d35400', routes: '—', pharmacies: '' },
  { car: '01 870 SEA', fullName: 'Хомидов Сардор', shortName: 'Сардор Х.', color: '#8e44ad', routes: '—', pharmacies: '' },
  { car: '01 668 UKA', fullName: 'Маматқулов Жасур', shortName: 'Жасур', color: '#2980b9', routes: '—', pharmacies: '' },
  { car: '01 887 UKA', fullName: 'Ахмадов Комил', shortName: 'Комил', color: '#c0392b', routes: '—', pharmacies: '' },
  { car: '01 449 UKA', fullName: 'Абдурахмонов Санжарбек', shortName: 'Санжарбек', color: '#7f8c8d', routes: '—', pharmacies: '' },
  { car: '01 646 UKA', fullName: 'Абдусаломов Хасан', shortName: 'Хасан А.', color: '#95a5a6', routes: '—', pharmacies: '' },
  { car: '01 844 FKA', fullName: 'Норқулов Гулом', shortName: 'Гулом', color: '#16a085', routes: '—', fuelType: 'dizel', pharmacies: '' },
  { car: '01 699 UKA', fullName: 'Турдиев Сардор', shortName: 'Сардор Т.', color: '#f39c12', routes: '—', pharmacies: '' },
  { car: '01 592 YNA', fullName: 'Турсунқулов Нурбек', shortName: 'Нурбек', color: '#2c3e50', routes: '—', pharmacies: '' },
  { car: '01 849 SNA', fullName: 'Абдурахимов Козим', shortName: 'Козим', color: '#27ae60', routes: '—', pharmacies: '' },
  { car: '01 309 YNA', fullName: 'Абдусатторов Акмал', shortName: 'Акмал', color: '#e84393', routes: '—', pharmacies: '' },
  { car: '01 331 MLA', fullName: 'Ахтамов', shortName: 'Ахтамов', color: '#7f8c8d', routes: '—', pharmacies: '' },
  { car: '01 406 GNA', fullName: '01 406 GNA', shortName: '406 GNA', color: '#95a5a6', routes: '—', pharmacies: '' },
  { car: '01 567 SGA', fullName: '01 567 SGA', shortName: '567 SGA', color: '#bdc3c7', routes: '—', pharmacies: '' }
];

const FLEET_BASE = FLEET_DRIVERS.map(d => ({
  car: d.car,
  name: d.fullName,
  short: d.shortName,
  brand: d.brand || '',
  fuelType: d.fuelType || 'mixed'
}));

window.DRIVERS = FLEET_DRIVERS;
window.FLEET_BASE = FLEET_BASE;
