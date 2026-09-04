// FBS stadium coordinates for the CFB Week weather forecast, keyed by ESPN venue id (stable across
// seasons). GENERATED — do not hand-edit; run `node scripts/gen-cfb-venues.mjs` and commit the
// result. That script explains where the numbers come from and how each one was checked.
//
// Coordinates are zip-code centroids from ESPN's own venue records — usually campus-specific, so
// normally within a couple of km of the stadium. A handful of venues carry a unique/PO-box or
// neighbouring-campus zip and land further out; against the hand-built bowl table, 26 of 30 shared
// venues agree within 8km and the worst is ~16km, which is immaterial for temperature, wind and
// precipitation. Every row was round-tripped through NWS /points and confirmed to resolve to the
// state ESPN reports for that venue; anything that failed was left out rather than guessed at.
//
// Domes carry no coordinate: the shared pipeline skips the forecast for them, and ESPN's per-game
// `indoor` flag is the authoritative override at build time anyway. A venue that isn't listed
// here simply gets no weather, which is the same graceful degrade the bowl table has.
//
// Generated from the 2026, 2025, 2024 FBS seasons · 172 venues (13 domed).
export const CFB_VENUES = {
  '347': { lat: 43.0356, lon: -89.4526, dome: false }, // Camp Randall Stadium — Madison, WI
  '477': { lat: 34.003, lon: -118.2863, dome: false }, // Los Angeles Memorial Coliseum — Los Angeles, CA
  '499': { lat: 32.7582, lon: -96.7623, dome: false }, // Cotton Bowl — Dallas, TX
  '587': { lat: 40.7659, lon: -111.8403, dome: false }, // Rice-Eccles Stadium — Salt Lake City, UT
  '721': { lat: 33.7763, lon: -84.398, dome: false }, // Bobby Dodd Stadium — Atlanta, GA
  '1056': { lat: 34.1669, lon: -118.1551, dome: false }, // Rose Bowl — Pasadena, CA
  '1400': { lat: 33.1507, lon: -96.8236, dome: false }, // Toyota Stadium — Frisco, TX
  '1964': { dome: true },                             // JMA Wireless Dome — Syracuse, NY
  '2031': { lat: 25.5584, lon: -80.4582, dome: false }, // Pitbull Stadium — Miami, FL
  '3486': { lat: 39.0803, lon: -94.7806, dome: false }, // Sporting Park — Kansas City, KS
  '3493': { dome: true },                             // Caesars Superdome — New Orleans, LA
  '3558': { lat: 42.2694, lon: -83.7282, dome: false }, // Michigan Stadium — Ann Arbor, MI
  '3601': { lat: 32.2738, lon: -106.7472, dome: false }, // Aggie Memorial Stadium — Las Cruces, NM
  '3604': { dome: true },                             // Alamodome — San Antonio, TX
  '3608': { lat: 32.4408, lon: -81.774, dome: false }, // Allen E. Paulson Stadium — Statesboro, GA
  '3615': { lat: 42.3164, lon: -71.1612, dome: false }, // Alumni Stadium (Chestnut Hill, MA) — Chestnut Hill, MA
  '3616': { lat: 32.7714, lon: -97.2915, dome: false }, // Amon G. Carter Stadium — Fort Worth, TX
  '3619': { lat: 32.2474, lon: -110.9491, dome: false }, // Casino Del Sol Stadium — Tucson, AZ
  '3622': { lat: 39.0401, lon: -94.4951, dome: false }, // Arrowhead Stadium — Kansas City, MO
  '3625': { lat: 35.833, lon: -90.6965, dome: false }, // Centennial Bank Stadium — Jonesboro, AR
  '3626': { lat: 44.0682, lon: -123.0819, dome: false }, // Autzen Stadium — Eugene, OR
  '3628': { lat: 35.229, lon: -80.8419, dome: false }, // Bank of America Stadium — Charlotte, NC
  '3630': { lat: 36.144, lon: -80.2376, dome: false }, // Allegacy Federal Credit Union Stadium — Winston-Salem, NC
  '3631': { lat: 29.7489, lon: -95.3391, dome: false }, // Shell Energy Stadium — Houston, TX
  '3632': { lat: 40.7997, lon: -77.8623, dome: false }, // Beaver Stadium — University Park, PA
  '3634': { lat: 29.6813, lon: -82.3539, dome: false }, // Ben Hill Griffin Stadium — Gainesville, FL
  '3636': { lat: 39.1938, lon: -96.5858, dome: false }, // Bill Snyder Family Stadium — Manhattan, KS
  '3644': { lat: 29.8754, lon: -97.9404, dome: false }, // UFCU Stadium — San Marcos, TX
  '3646': { lat: 36.1396, lon: -97.063, dome: false }, // Boone Pickens Stadium — Stillwater, OK
  '3647': { lat: 30.6448, lon: -95.5798, dome: false }, // Elliott T. Bowers Stadium — Huntsville, TX
  '3651': { lat: 38.4409, lon: -78.8742, dome: false }, // Bridgeforth Stadium — Harrisonburg, VA
  '3652': { lat: 28.5663, lon: -81.2608, dome: false }, // Acrisure Bounce House — Orlando, FL
  '3653': { lat: 43.5885, lon: -116.191, dome: false }, // Albertsons Stadium — Boise, ID
  '3654': { lat: 33.8731, lon: -79.0557, dome: false }, // Brooks Stadium (SC) — Conway, SC
  '3657': { lat: 33.1969, lon: -87.5627, dome: false }, // Bryant-Denny Stadium — Tuscaloosa, AL
  '3660': { lat: 36.8236, lon: -119.762, dome: false }, // Valley Children's Stadium — Fresno, CA
  '3662': { lat: 33.831, lon: -85.7752, dome: false }, // AmFirst Stadium — Jacksonville, AL
  '3665': { lat: 38.9896, lon: -76.9457, dome: false }, // SECU Stadium — College Park, MD
  '3666': { lat: 30.2077, lon: -92.0656, dome: false }, // Our Lady of Lourdes Stadium — Lafayette, LA
  '3670': { lat: 35.8014, lon: -78.6877, dome: false }, // Carter-Finley Stadium — Raleigh, NC
  '3673': { lat: 47.5903, lon: -122.3263, dome: false }, // Lumen Field — Seattle, WA
  '3674': { lat: 36.1464, lon: -95.9526, dome: false }, // H. A. Chapman Stadium — Tulsa, OK
  '3683': { lat: 38.0287, lon: -84.5075, dome: false }, // Kroger Field — Lexington, KY
  '3687': { dome: true },                             // AT&T Stadium — Arlington, TX
  '3689': { lat: 32.3804, lon: -86.2799, dome: false }, // Cramton Bowl — Montgomery, AL
  '3693': { lat: 33.4156, lon: -88.7433, dome: false }, // Davis Wade Stadium — Starkville, MS
  '3695': { lat: 39.6699, lon: -75.7151, dome: false }, // Delaware Stadium — Newark, DE
  '3696': { lat: 41.17, lon: -81.1966, dome: false }, // Zoeller Field at Dix Stadium — Kent, OH
  '3697': { lat: 30.4478, lon: -84.3211, dome: false }, // Doak Campbell Stadium — Tallahassee, FL
  '3699': { lat: 35.6127, lon: -77.3663, dome: false }, // Dowdy-Ficklen Stadium — Greenville, NC
  '3700': { lat: 41.377, lon: -83.6371, dome: false }, // Doyt L. Perry Stadium — Bowling Green, OH
  '3712': { lat: 30.3299, lon: -81.6517, dome: false }, // EverBank Stadium — Jacksonville, FL
  '3713': { lat: 38.9792, lon: -104.8606, dome: false }, // Falcon Stadium — USAF Academy, CO
  '3714': { dome: true },                             // Fargodome — Fargo, ND
  '3715': { lat: 26.3799, lon: -80.0975, dome: false }, // Flagler Credit Union Stadium — Boca Raton, FL
  '3719': { lat: 38.9223, lon: -76.8755, dome: false }, // Northwest Stadium — Landover, MD
  '3725': { lat: 35.8478, lon: -86.3647, dome: false }, // Johnny "Red" Floyd Stadium — Murfreesboro, TN
  '3726': { lat: 39.9807, lon: -105.2531, dome: false }, // Folsom Field — Boulder, CO
  '3727': { dome: true },                             // Ford Field — Detroit, MI
  '3735': { lat: 32.826, lon: -96.7843, dome: false }, // Gerald J. Ford Stadium — Dallas, TX
  '3738': { lat: 42.0649, lon: -71.2441, dome: false }, // Gillette Stadium — Foxborough, MA
  '3739': { lat: 41.6712, lon: -83.606, dome: false }, // Glass Bowl — Toledo, OH
  '3752': { lat: 40.4282, lon: -80.075, dome: false }, // Acrisure Stadium — Pittsburgh, PA
  '3757': { lat: 38.5683, lon: -121.4366, dome: false }, // Hornet Stadium — Sacramento, CA
  '3764': { lat: 41.9008, lon: -88.7548, dome: false }, // Huskie Stadium — Dekalb, IL
  '3765': { lat: 47.6564, lon: -122.3048, dome: false }, // Husky Stadium — Seattle, WA
  '3766': { lat: 32.474, lon: -93.8013, dome: false }, // Independence Stadium — Shreveport, LA
  '3768': { lat: 41.0808, lon: -81.5085, dome: false }, // InfoCision Stadium — Akron, OH
  '3772': { lat: 42.036, lon: -93.4652, dome: false }, // Jack Trice Stadium — Ames, IA
  '3775': { lat: 38.4211, lon: -82.4227, dome: false }, // Joan C. Edwards Stadium — Huntington, WV
  '3776': { lat: 32.5308, lon: -92.6439, dome: false }, // Joe Aillet Stadium — Ruston, LA
  '3784': { lat: 33.5684, lon: -101.9423, dome: false }, // Galaxy Stadium — Lubbock, TX
  '3785': { lat: 32.6024, lon: -85.4873, dome: false }, // Jordan-Hare Stadium — Auburn, AL
  '3786': { lat: 43.6013, lon: -84.7736, dome: false }, // Kelly/Shorts Stadium — Mount Pleasant, MI
  '3787': { lat: 35.9203, lon: -79.0372, dome: false }, // Kenan Stadium — Chapel Hill, NC
  '3792': { lat: 36.2142, lon: -81.666, dome: false }, // Kidd Brewer Stadium — Boone, NC
  '3793': { lat: 41.6355, lon: -91.5016, dome: false }, // Kinnick Stadium — Iowa City, IA
  '3795': { lat: 30.6045, lon: -96.3123, dome: false }, // Kyle Field — College Station, TX
  '3796': { lat: 37.0174, lon: -86.4518, dome: false }, // Houchens Industries-L.T. Smith Stadium — Bowling Green, KY
  '3798': { lat: 44.4975, lon: -88.0324, dome: false }, // Lambeau Field — Green Bay, WI
  '3799': { lat: 37.2563, lon: -80.4347, dome: false }, // Lane Stadium — Blacksburg, VA
  '3801': { lat: 40.2607, lon: -111.6549, dome: false }, // LaVell Edwards Stadium — Provo, UT
  '3805': { lat: 35.1334, lon: -90.0046, dome: false }, // Simmons Bank Liberty Stadium — Memphis, TN
  '3806': { lat: 39.9207, lon: -75.1595, dome: false }, // Lincoln Financial Field — Philadelphia, PA
  '3810': { lat: 36.1663, lon: -86.7669, dome: false }, // Nissan Stadium — Nashville, TN
  '3812': { dome: true },                             // Lucas Oil Stadium — Indianapolis, IN
  '3814': { lat: 39.2645, lon: -76.6224, dome: false }, // M&T Bank Stadium — Baltimore, MD
  '3815': { lat: 31.1721, lon: -89.2948, dome: false }, // M. M. Roberts Stadium — Hattiesburg, MS
  '3816': { lat: 40.5412, lon: -119.5869, dome: false }, // Mackay Stadium — Reno, NV
  '3817': { lat: 32.553, lon: -92.0422, dome: false }, // Malone Stadium — Monroe, LA
  '3820': { lat: 46.8387, lon: -117.6443, dome: false }, // Martin Stadium — Pullman, WA
  '3825': { lat: 33.1903, lon: -97.1282, dome: false }, // DATCU Stadium — Denton, TX
  '3830': { lat: 39.2303, lon: -86.4692, dome: false }, // Memorial Stadium (Bloomington, IN) — Bloomington, IN
  '3831': { lat: 37.8738, lon: -122.2549, dome: false }, // California Memorial Stadium — Berkeley, CA
  '3832': { lat: 40.111, lon: -88.2407, dome: false }, // Gies Memorial Stadium — Champaign, IL
  '3833': { lat: 39.0289, lon: -95.2086, dome: false }, // David Booth Kansas Memorial Stadium — Lawrence, KS
  '3834': { lat: 40.8145, lon: -96.7009, dome: false }, // Memorial Stadium (Lincoln, NE) — Lincoln, NE
  '3835': { lat: 35.2086, lon: -97.4445, dome: false }, // Memorial Stadium (Norman, OK) — Norman, OK
  '3836': { lat: 34.8474, lon: -82.7101, dome: false }, // Memorial Stadium (Clemson, SC) — Clemson, SC
  '3838': { lat: 38.9348, lon: -92.3639, dome: false }, // Memorial Stadium — Columbia, MO
  '3839': { lat: 40.8385, lon: -74.1041, dome: false }, // MetLife Stadium — East Rutherford, NJ
  '3841': { lat: 41.3945, lon: -73.9737, dome: false }, // Michie Stadium — West Point, NY
  '3842': { lat: 39.6505, lon: -79.944, dome: false }, // Milan Puskar Stadium — Morgantown, WV
  '3852': { lat: 38.9898, lon: -76.5501, dome: false }, // Navy-Marine Corps Memorial Stadium — Annapolis, MD
  '3853': { lat: 35.9901, lon: -83.9622, dome: false }, // Neyland Stadium — Knoxville, TN
  '3854': { lat: 39.1668, lon: -84.5382, dome: false }, // Nippert Stadium — Cincinnati, OH
  '3855': { lat: 41.5968, lon: -86.293, dome: false }, // Notre Dame Stadium — Notre Dame, IN
  '3861': { lat: 40.0028, lon: -83.0164, dome: false }, // Ohio Stadium — Columbus, OH
  '3873': { lat: 38.22, lon: -85.7648, dome: false }, // L&N Federal Credit Union Stadium — Louisville, KY
  '3876': { lat: 39.3178, lon: -82.102, dome: false }, // Peden Stadium — Athens, OH
  '3878': { lat: 37.1987, lon: -93.2784, dome: false }, // Robert W. Plaster Stadium — Springfield, MO
  '3886': { lat: 27.9625, lon: -82.4895, dome: false }, // Raymond James Stadium — Tampa, FL
  '3887': { lat: 36.052, lon: -94.1534, dome: false }, // Donald W. Reynolds Razorback Stadium — Fayetteville, AR
  '3891': { dome: true },                             // Reliant Stadium — Houston, TX
  '3892': { lat: 41.7472, lon: -72.6103, dome: false }, // Pratt & Whitney Stadium — East Hartford, CT
  '3893': { lat: 44.5638, lon: -123.2779, dome: false }, // Reser Stadium — Corvallis, OR
  '3895': { lat: 29.7179, lon: -95.4263, dome: false }, // Rice Stadium — Houston, TX
  '3905': { lat: 41.7759, lon: -111.8068, dome: false }, // Maverik Stadium — Logan, UT
  '3907': { lat: 40.444, lon: -86.9237, dome: false }, // Ross-Ade Stadium — West Lafayette, IN
  '3910': { lat: 30.2852, lon: -97.7354, dome: false }, // DKR-Texas Memorial Stadium — Austin, TX
  '3912': { lat: 42.2325, lon: -83.6336, dome: false }, // Rynearson Stadium — Ypsilanti, MI
  '3917': { lat: 33.9433, lon: -83.3724, dome: false }, // Sanford Stadium — Athens, GA
  '3918': { lat: 36.8859, lon: -76.3004, dome: false }, // S.B. Ballard Stadium — Norfolk, VA
  '3919': { lat: 40.2111, lon: -85.4291, dome: false }, // Scheumann Stadium — Muncie, IN
  '3923': { lat: 38.0339, lon: -78.4924, dome: false }, // Scott Stadium — Charlottesville, VA
  '3935': { lat: 37.3476, lon: -121.887, dome: false }, // CEFCU Stadium — San Jose, CA
  '3936': { lat: 42.7283, lon: -84.4882, dome: false }, // Spartan Stadium — East Lansing, MI
  '3940': { lat: 37.4236, lon: -122.1619, dome: false }, // Stanford Stadium — Stanford, CA
  '3946': { lat: 31.7763, lon: -106.4932, dome: false }, // Sun Bowl — El Paso, TX
  '3947': { lat: 33.4285, lon: -111.9349, dome: false }, // Mountain America Stadium — Tempe, AZ
  '3948': { lat: 25.9484, lon: -80.2479, dome: false }, // Hard Rock Stadium — Miami Gardens, FL
  '3953': { lat: 44.9735, lon: -93.2331, dome: false }, // Huntington Bank Stadium — Minneapolis, MN
  '3958': { lat: 30.405, lon: -91.1868, dome: false }, // Tiger Stadium (LA) — Baton Rouge, LA
  '3965': { lat: 43.0408, lon: -78.7812, dome: false }, // Broadview Stadium — Buffalo, NY
  '3970': { dome: true },                             // State Farm Stadium — Glendale, AZ
  '3971': { lat: 35.079, lon: -106.6169, dome: false }, // University Stadium (NM) — Albuquerque, NM
  '3973': { lat: 36.1337, lon: -86.8006, dome: false }, // FirstBank Stadium — Nashville, TN
  '3974': { lat: 34.3308, lon: -89.4835, dome: false }, // Vaught-Hemingway Stadium — Oxford, MS
  '3975': { lat: 31.8028, lon: -85.9546, dome: false }, // Veterans Memorial Stadium (AL) — Troy, AL
  '3980': { lat: 42.2624, lon: -85.6096, dome: false }, // Waldo Stadium — Kalamazoo, MI
  '3982': { lat: 36.0287, lon: -78.924, dome: false }, // Wallace Wade Stadium — Durham, NC
  '3983': { lat: 34.751, lon: -92.3455, dome: false }, // War Memorial Stadium (AR) — Little Rock, AR
  '3984': { lat: 41.439, lon: -105.801, dome: false }, // War Memorial Stadium — Laramie, WY
  '3985': { lat: 42.3919, lon: -72.5248, dome: false }, // Warren McGuirk Alumni Stadium — Amherst, MA
  '3992': { lat: 37.3825, lon: -79.2181, dome: false }, // Williams Stadium (VA) — Lynchburg, VA
  '3994': { lat: 34.0004, lon: -81.0334, dome: false }, // Williams-Brice Stadium — Columbia, SC
  '3996': { lat: 39.4792, lon: -84.6858, dome: false }, // Yager Stadium — Oxford, OH
  '4013': { lat: 28.5302, lon: -81.4045, dome: false }, // Camping World Stadium — Orlando, FL
  '4102': { lat: 40.8222, lon: -73.9217, dome: false }, // Yankee Stadium — Bronx, NY
  '4245': { lat: 42.3389, lon: -70.9196, dome: false }, // Fenway Park — Boston, MA
  '4246': { lat: 33.7051, lon: -84.3808, dome: false }, // Center Parc Stadium — Atlanta, GA
  '4250': { lat: 41.9543, lon: -87.6575, dome: false }, // Wrigley Field — Chicago, IL
  '4251': { dome: true },                             // Chase Field — Phoenix, AZ
  '4418': { lat: 35.3041, lon: -80.7267, dome: false }, // Jerry Richardson Stadium — Charlotte, NC
  '4727': { lat: 31.5773, lon: -97.1241, dome: false }, // McLane Stadium — Waco, TX
  '4728': { lat: 29.834, lon: -95.4342, dome: false }, // TDECU Stadium — Houston, TX
  '4729': { lat: 29.9504, lon: -90.1236, dome: false }, // Yulman Stadium — New Orleans, LA
  '4899': { lat: 34.0287, lon: -84.6047, dome: false }, // Walens Family Field at Fifth Third Stadium — Kennesaw, GA
  '5348': { dome: true },                             // Mercedes-Benz Stadium — Atlanta, GA
  '5388': { lat: 40.5813, lon: -105.1039, dome: false }, // Canvas Stadium — Fort Collins, CO
  '5455': { dome: true },                             // Ford Center At The Star — Frisco, TX
  '5960': { lat: 42.0586, lon: -87.6845, dome: false }, // Northwestern Medicine Field at Martin Stadium — Evanston, IL
  '6501': { dome: true },                             // Allegiant Stadium — Las Vegas, NV
  '6526': { lat: 30.6962, lon: -88.1821, dome: false }, // Hancock Whitney Stadium — Mobile, AL
  '6577': { lat: 40.5515, lon: -74.459, dome: false }, // SHI Stadium — Piscataway, NJ
  '7065': { lat: 33.955, lon: -118.3556, dome: false }, // SoFi Stadium — Inglewood, CA
  '7173': { lat: 39.1271, lon: -84.5144, dome: false }, // TQL Stadium — Cincinnati, OH
  '7220': { lat: 21.3117, lon: -157.8298, dome: false }, // Clarence T.C. Ching Athletics Complex — Honolulu, HI
  '7221': { lat: 33.521, lon: -86.8066, dome: false }, // Protective Stadium — Birmingham, AL
  '7311': { lat: 32.7783, lon: -117.1335, dome: false }, // Snapdragon Stadium — San Diego, CA
  '11823': { lat: 42.0586, lon: -87.6845, dome: false }, // Ryan Field — Evanston, IL
  '11946': { lat: 18.3986, lon: -66.1557, dome: false }, // Juan Ramón Loubriel Stadium — Bayamon, 
};
