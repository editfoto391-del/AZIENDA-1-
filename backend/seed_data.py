"""Seed data constants for SUPER IQ-FOAM ERP."""

EMPLOYEE_PAYROLL_ROSTER = [
    {"name": "YUSUF", "department": "CHEMICAL", "weekly_salary": 1150, "hours_per_week": 45, "pay_type": "hourly"},
    {"name": "SEAN", "department": "CHEMICAL", "weekly_salary": 1000, "hours_per_week": 45, "pay_type": "hourly"},
    {"name": "MANDLENKOSI", "department": "CHEMICAL", "weekly_salary": 1000, "hours_per_week": 45, "pay_type": "hourly"},
    {"name": "MSIZI", "department": "CHEMICAL", "weekly_salary": 1000, "hours_per_week": 45, "pay_type": "hourly"},
    {"name": "MTLENI", "department": "CHEMICAL", "weekly_salary": 1000, "hours_per_week": 45, "pay_type": "hourly"},
    {"name": "SIPHOKAZI", "department": "COVER STITCHING", "weekly_salary": 1000, "hours_per_week": 45, "pay_type": "hourly"},
    {"name": "ASIPHE", "department": "COVER STITCHING", "weekly_salary": 1000, "hours_per_week": 45, "pay_type": "hourly"},
    {"name": "NONTEMBISO", "department": "COVER STITCHING", "weekly_salary": 900, "hours_per_week": 45, "pay_type": "hourly"},
    {"name": "CASSIM", "department": "COVER STITCHING", "weekly_salary": 900, "hours_per_week": 45, "pay_type": "hourly"},
    {"name": "SNOVOYO", "department": "COVER STITCHING", "weekly_salary": 900, "hours_per_week": 45, "pay_type": "hourly"},
    {"name": "NTOSH", "department": "FABRIC CUTTING", "weekly_salary": 1000, "hours_per_week": 45, "pay_type": "hourly"},
    {"name": "ANELE FABRIC", "department": "FABRIC CUTTING", "weekly_salary": 1000, "hours_per_week": 45, "pay_type": "hourly"},
    {"name": "HASSAN TAILOR", "department": "TAILORING (TAPE EDGE)", "weekly_salary": 900, "hours_per_week": 45, "pay_type": "hourly"},
    {"name": "AYANDA TAILOR", "department": "TAILORING (TAPE EDGE)", "weekly_salary": 900, "hours_per_week": 45, "pay_type": "hourly"},
    {"name": "ASIVE TAILOR", "department": "TAILORING (TAPE EDGE)", "weekly_salary": 900, "hours_per_week": 45, "pay_type": "hourly"},
    {"name": "MNEH", "department": "MATTRESS PACKING (PLASTING)", "weekly_salary": 1000, "hours_per_week": 45, "pay_type": "hourly"},
    {"name": "ANELE PLASTIC", "department": "MATTRESS PACKING (PLASTING)", "weekly_salary": 1000, "hours_per_week": 45, "pay_type": "hourly"},
    {"name": "ZUKO", "department": "MATTRESS PACKING (PLASTING)", "weekly_salary": 1000, "hours_per_week": 45, "pay_type": "hourly"},
    {"name": "VIDO", "department": "MATTRESS COVERING AND LOADING", "weekly_salary": 1000, "hours_per_week": 45, "pay_type": "hourly"},
    {"name": "LUNGHISANI", "department": "CHEMICAL", "weekly_salary": 900, "hours_per_week": 45, "pay_type": "hourly"},
    {"name": "KHATAZA", "department": "MATTRESS COVERING AND LOADING", "weekly_salary": 900, "hours_per_week": 45, "pay_type": "hourly"},
    {"name": "NDIKHO", "department": "MATTRESS COVERING AND LOADING", "weekly_salary": 900, "hours_per_week": 45, "pay_type": "hourly"},
    {"name": "TMABANE", "department": "CHEMICAL", "weekly_salary": 800, "hours_per_week": 45, "pay_type": "hourly"},
    {"name": "THEMMINKOSI", "department": "MATTRESS COVERING AND LOADING", "weekly_salary": 800, "hours_per_week": 45, "pay_type": "hourly"},
    {"name": "SHERIF", "department": "MATTRESS COVERING AND LOADING", "weekly_salary": 1000, "hours_per_week": 45, "pay_type": "hourly"},
    {"name": "ABDUL DRIVER", "department": "DRIVING", "weekly_salary": 1550, "hours_per_week": 45, "pay_type": "hourly"},
    {"name": "SIYANDA", "department": "DRIVING", "weekly_salary": 1000, "hours_per_week": 45, "pay_type": "hourly"},
    {"name": "AYANDA BHAI", "department": "DRIVING", "weekly_salary": 1300, "hours_per_week": 45, "pay_type": "hourly"},
    {"name": "NTOKOZO", "department": "DRIVING", "weekly_salary": 1100, "hours_per_week": 45, "pay_type": "hourly"},
    {"name": "BILAL", "department": "DRIVING", "weekly_salary": 1000, "hours_per_week": 45, "pay_type": "hourly"},
    {"name": "SECURITY GUARD", "department": "SECURITY", "weekly_salary": 1000, "hours_per_week": 45, "pay_type": "hourly"},
]

EMPLOYEE_PAYROLL_NAME_ALIASES = {
    "MINEH": "MNEH",
    "TMBANE": "TMABANE",
}

PIECEWORK_EMPLOYEE_NAMES = {"AYANDA TAILOR", "ASIVE TAILOR"}

CUSTOMERS = [
    "AB WAKA WAKA", "ABBAS QUMBO", "ABC TSOLO", "ABDUL LUSIKISIKI",
    "AD BANTU BONKE", "ADDIS HARDING", "ADIL UMZ", "AHMAD YAR",
    "AKBAR JABULA BLANKETS", "AL HASSAN",
]

# zone, category, {size: price or None}
PRICES = []

def _add(zone, category, items):
    for size, price in items.items():
        PRICES.append({"zone": zone, "category": category, "size": size,
                       "price": price, "active": True,
                       "confirmed": price is not None})

# ---------------- ZONE 1 ----------------
_add(1, "Standard", {
    "760x50": 85.00, "760x75": 130.00, "760x100": 160.00, "760x120": 198.00, "760x150": 232.00,
    "910x50": 105.00, "910x75": 145.00, "910x100": 171.00, "910x120": 205.00, "910x150": 255.00,
    "1070x50": 116.50, "1070x75": 175.00, "1070x100": 203.00, "1070x120": 250.00, "1070x150": 292.00,
    "1370x50": 165.00, "1370x75": 200.00, "1370x100": 260.00, "1370x120": 310.00, "1370x150": 387.50,
})
_RIB1 = {
    "760x100": 198.00,
    "910x100": 215.00, "910x120": 258.00, "910x150": 322.00,
    "1070x100": 255.00, "1070x120": 285.00,
    "1370x120": 335.00,
    "1370x150": None,  # ALWAYS manual price + admin confirmation
}
for _c in ("Ribbon Black", "Ribbon Pink"):
    _add(1, _c, _RIB1)
_add(1, "Strong Boy", {
    "760x125": 285.00, "910x125": 375.00, "1070x125": 410.00, "1370x125": 550.00,
})
_add(1, "Uncovered", {
    "910x100": 195.00, "1070x100": 233.00,
})

# ---------------- ZONE 2 ----------------
_add(2, "Standard", {
    "760x50": 95.00, "760x75": 130.00, "760x100": 170.00, "760x120": 208.00, "760x150": 235.00,
    "910x50": 115.00, "910x75": 155.00, "910x100": 181.00, "910x120": 228.00, "910x150": 285.00,
    "1070x50": 123.00, "1070x75": 185.00, "1070x100": 215.00, "1070x120": 255.00, "1070x150": 300.00,
    "1370x50": 175.00, "1370x75": 210.00, "1370x100": 265.00, "1370x120": 325.00, "1370x150": 407.00,
})
_RIB2 = {
    "760x100": 200.00, "760x120": 240.00, "760x150": 300.00,
    "910x100": 225.00, "910x120": 258.00, "910x150": 338.00,
    "1070x100": 265.00, "1070x120": 295.00,
    "1370x100": 310.00, "1370x120": 372.00,
    "1370x150": None,  # UNCONFIRMED - requires admin configuration
}
for _c in ("Ribbon Black", "Ribbon Pink"):
    _add(2, _c, _RIB2)
_add(2, "Strong Boy", {
    "760x125": 320.00, "910x125": 385.00, "1070x125": 410.00, "1370x125": 525.00,
})
_add(2, "Uncovered Blue 16 Density", {
    "910x100": 240.00, "1070x100": 290.00,
})

STOCK = [
    {"product": "Simple", "size": "760x50", "opening": 265, "threshold": 0},
    {"product": "Simple", "size": "760x75", "opening": 100, "threshold": 0},
    {"product": "Simple", "size": "760x100", "opening": 170, "threshold": 0},
    {"product": "Simple", "size": "760x120", "opening": 290, "threshold": 0},
    {"product": "Simple", "size": "760x150", "opening": 60, "threshold": 0},
    {"product": "Simple", "size": "910x50", "opening": 365, "threshold": 0},
    {"product": "Simple", "size": "910x75", "opening": 490, "threshold": 0},
    {"product": "Simple", "size": "910x100", "opening": 660, "threshold": 0},
    {"product": "Simple", "size": "910x120", "opening": 365, "threshold": 0},
    {"product": "Simple", "size": "910x150", "opening": 147, "threshold": 0},
    {"product": "Simple", "size": "1070x50", "opening": 140, "threshold": 0},
    {"product": "Simple", "size": "1070x75", "opening": 280, "threshold": 0},
    {"product": "Simple", "size": "1070x100", "opening": 290, "threshold": 10},
    {"product": "Simple", "size": "1070x120", "opening": 335, "threshold": 0},
    {"product": "Simple", "size": "1070x150", "opening": 45, "threshold": 0},
    {"product": "Simple", "size": "1370x50", "opening": 115, "threshold": 0},
    {"product": "Simple", "size": "1370x75", "opening": 70, "threshold": 0},
    {"product": "Simple", "size": "1370x100", "opening": 150, "threshold": 0},
    {"product": "Simple", "size": "1370x120", "opening": 90, "threshold": 0},
    {"product": "Simple", "size": "1370x150", "opening": 40, "threshold": 0},
    {"product": "Ribbon Pink", "size": "760x100", "opening": 5, "threshold": 0},
    {"product": "Ribbon Pink", "size": "760x120", "opening": 0, "threshold": 0},
    {"product": "Ribbon Pink", "size": "760x150", "opening": 0, "threshold": 0},
    {"product": "Ribbon Pink", "size": "910x100", "opening": 53, "threshold": 5},
    {"product": "Ribbon Pink", "size": "910x120", "opening": 25, "threshold": 0},
    {"product": "Ribbon Pink", "size": "910x150", "opening": 0, "threshold": 0},
    {"product": "Ribbon Pink", "size": "1070x100", "opening": 45, "threshold": 0},
    {"product": "Ribbon Pink", "size": "1070x120", "opening": 105, "threshold": 0},
    {"product": "Ribbon Pink", "size": "1070x150", "opening": 0, "threshold": 0},
    {"product": "Ribbon Pink", "size": "1370x100", "opening": 0, "threshold": 0},
    {"product": "Ribbon Pink", "size": "1370x120", "opening": 0, "threshold": 0},
    {"product": "Ribbon Pink", "size": "1370x150", "opening": 0, "threshold": 0},
    {"product": "Strong Boy", "size": "760x125", "opening": 0, "threshold": 0},
    {"product": "Strong Boy", "size": "910x125", "opening": 0, "threshold": 0},
    {"product": "Strong Boy", "size": "1070x125", "opening": 10, "threshold": 0},
    {"product": "Strong Boy", "size": "1370x125", "opening": 0, "threshold": 0},
    {"product": "Uncovered", "size": "910x100", "opening": 30, "threshold": 0},
    {"product": "Uncovered", "size": "1070x100", "opening": 10, "threshold": 0},
    {"product": "Uncovered", "size": "1370x100", "opening": 0, "threshold": 0},
    {"product": "Candy", "size": "760x100", "opening": 10, "threshold": 8},
    {"product": "Candy", "size": "910x100", "opening": 10, "threshold": 0},
    {"product": "Candy", "size": "910x120", "opening": 0, "threshold": 0},
    {"product": "Candy", "size": "910x125", "opening": 0, "threshold": 0},
    {"product": "Candy", "size": "1070x100", "opening": 0, "threshold": 0},
    {"product": "Candy", "size": "1070x120", "opening": 0, "threshold": 0},
    {"product": "Candy", "size": "1370x100", "opening": 0, "threshold": 0},
    {"product": "Candy", "size": "1370x120", "opening": 0, "threshold": 0},
    {"product": "Ribbon Black", "size": "760x100", "opening": 30, "threshold": 0},
    {"product": "Ribbon Black", "size": "760x120", "opening": 5, "threshold": 0},
    {"product": "Ribbon Black", "size": "760x150", "opening": 0, "threshold": 0},
    {"product": "Ribbon Black", "size": "910x100", "opening": 35, "threshold": 5},
    {"product": "Ribbon Black", "size": "910x120", "opening": 5, "threshold": 0},
    {"product": "Ribbon Black", "size": "910x150", "opening": 45, "threshold": 0},
    {"product": "Ribbon Black", "size": "1070x100", "opening": 135, "threshold": 0},
    {"product": "Ribbon Black", "size": "1070x120", "opening": 130, "threshold": 0},
    {"product": "Ribbon Black", "size": "1070x150", "opening": 0, "threshold": 0},
]

DRIVERS = [
    {"name": "Abdul", "preferences": "Prefers larger, long-distance deliveries. Normal hours ~08:00-17:00. Do not auto-calculate overtime.", "size_pref": "large", "active": True},
    {"name": "Tkoso", "preferences": "Prefers small & medium deliveries; can handle larger when needed. Prefer normal hours.", "size_pref": "small", "active": True},
    {"name": "Ayanda", "preferences": "Prefers small & medium deliveries; can handle larger when needed. Prefer normal hours.", "size_pref": "small", "active": True},
]

TRAILERS = [
    {"name": "Trailer", "registration": "", "vtype": "Trailer", "capacity": "", "length": "9 m", "available": True, "notes": "Largest trailer"},
    {"name": "Trailer (2)", "registration": "", "vtype": "Trailer", "capacity": "", "length": "5 m", "available": True, "notes": ""},
    {"name": "Trailer (3)", "registration": "", "vtype": "Trailer", "capacity": "", "length": "4 m", "available": True, "notes": ""},
]

FLEET = [
    {"name": "Mighty Hyundai Truck", "registration": "", "vtype": "Medium Truck", "model": "Hyundai Mighty EX8", "consumption_min": 15, "consumption_max": 21, "payload_kg": 5000, "capacity": "approx. 5 t", "length": "", "available": True, "notes": ""},
    {"name": "Hino 500", "registration": "", "vtype": "Large Truck", "model": "Hino 500 (7 t)", "consumption_min": 20, "consumption_max": 27, "payload_kg": 7000, "capacity": "approx. 7 t (confirm specs)", "length": "", "available": True, "notes": "Largest truck"},
    {"name": "Hino 300", "registration": "", "vtype": "Medium Truck", "model": "Hino 300 816", "consumption_min": 15, "consumption_max": 20, "payload_kg": 4500, "capacity": "approx. 4.5–5 t", "length": "", "available": True, "notes": ""},
    {"name": "Trailer (1)", "registration": "", "vtype": "Trailer", "capacity": "", "length": "9 m", "available": True, "notes": "Largest trailer"},
    {"name": "Trailer (2)", "registration": "", "vtype": "Trailer", "capacity": "", "length": "5 m", "available": True, "notes": ""},
    {"name": "Trailer (3)", "registration": "", "vtype": "Trailer", "capacity": "", "length": "4 m", "available": True, "notes": ""},
]
RETIRED_PLACEHOLDERS = ["Disk", "Truck", "Bakkie"]
VEHICLE_TYPES = ["Medium Truck", "Large Truck", "Small Truck", "Bakkie", "Trailer", "Other"]

EXPENSE_CATEGORIES = ["General", "Materials", "Fuel", "Salaries", "Rent", "Utilities", "Vehicle", "Maintenance", "Other"]

DEFAULT_SETTINGS = {
    "id": "singleton",
    "company_name": "SUPER IQ-FOAM",
    "address": "", "telephone": "", "email": "", "logo": "",
    "banking_details": "", "tax_number": "",
    "tax_enabled": False, "tax_rate": 15.0,
    "invoice_prefix": "IQF",
    "payment_terms": ["Due on Delivery", "Cash on Delivery", "7 Days", "14 Days", "30 Days", "Custom Terms"],
    "payment_methods": ["Cash", "Bank Transfer", "Card", "Other"],
    "default_payment_terms": "Due on Delivery",
    "resting_hours": 12,
    "safety_stock": 10,
    "departments": ["Production", "Cutting", "Sewing", "Mattress Processing", "Dispatch", "Administration", "Drivers"],
    "expense_categories": EXPENSE_CATEGORIES,
    "vehicle_types": VEHICLE_TYPES,
    "product_categories": ["Standard", "Ribbon Black", "Ribbon Pink", "Candy", "Strong Boy", "Uncovered", "Uncovered Blue 16 Density"],
    "bundle_sizes": {"default": 5, "50": 10, "75": 10},
    "timezone": "Africa/Johannesburg",
}

IQFOAM_UNIFIED_PRICES = [
    {"category": "Simple", "size": "760x50", "price": 105.00},
    {"category": "Simple", "size": "760x75", "price": 150.00},
    {"category": "Simple", "size": "760x100", "price": 177.00},
    {"category": "Simple", "size": "760x120", "price": 208.00},
    {"category": "Simple", "size": "760x150", "price": 265.50},
    {"category": "Simple", "size": "910x50", "price": 120.00},
    {"category": "Simple", "size": "910x75", "price": 158.00},
    {"category": "Simple", "size": "910x100", "price": 199.00},
    {"category": "Simple", "size": "910x120", "price": 239.00},
    {"category": "Simple", "size": "910x150", "price": 298.50},
    {"category": "Simple", "size": "1070x50", "price": None},
    {"category": "Simple", "size": "1070x75", "price": None},
    {"category": "Simple", "size": "1070x100", "price": 215.00},
    {"category": "Simple", "size": "1070x120", "price": 260.00},
    {"category": "Simple", "size": "1070x150", "price": 322.50},
    {"category": "Simple", "size": "1370x50", "price": None},
    {"category": "Simple", "size": "1370x75", "price": None},
    {"category": "Simple", "size": "1370x100", "price": 280.00},
    {"category": "Simple", "size": "1370x120", "price": 335.00},
    {"category": "Simple", "size": "1370x150", "price": 420.00},
    {"category": "Ribbon Black", "size": "760x100", "price": 217.00},
    {"category": "Ribbon Black", "size": "760x120", "price": None},
    {"category": "Ribbon Black", "size": "760x150", "price": None},
    {"category": "Ribbon Black", "size": "910x100", "price": 239.00},
    {"category": "Ribbon Black", "size": "910x120", "price": 279.00},
    {"category": "Ribbon Black", "size": "910x150", "price": 338.50},
    {"category": "Ribbon Black", "size": "1070x100", "price": 265.00},
    {"category": "Ribbon Black", "size": "1070x120", "price": 300.00},
    {"category": "Ribbon Black", "size": "1070x150", "price": 365.00},
    {"category": "Ribbon Black", "size": "1370x100", "price": 320.00},
    {"category": "Ribbon Black", "size": "1370x120", "price": 375.00},
    {"category": "Ribbon Black", "size": "1370x150", "price": 480.00},
    {"category": "Ribbon Pink", "size": "760x100", "price": 217.00},
    {"category": "Ribbon Pink", "size": "760x120", "price": None},
    {"category": "Ribbon Pink", "size": "760x150", "price": None},
    {"category": "Ribbon Pink", "size": "910x100", "price": 239.00},
    {"category": "Ribbon Pink", "size": "910x120", "price": 279.00},
    {"category": "Ribbon Pink", "size": "910x150", "price": 338.50},
    {"category": "Ribbon Pink", "size": "1070x100", "price": 265.00},
    {"category": "Ribbon Pink", "size": "1070x120", "price": 300.00},
    {"category": "Ribbon Pink", "size": "1070x150", "price": 365.00},
    {"category": "Ribbon Pink", "size": "1370x100", "price": 320.00},
    {"category": "Ribbon Pink", "size": "1370x120", "price": 375.00},
    {"category": "Ribbon Pink", "size": "1370x150", "price": 480.00},
]

CITY_DISTANCES_KM = {  # approximate one-way road km from Kokstad (ESTIMATES - edit in Settings)
    "KOKSTAD": 0, "CEDARVILLE": 55, "UMZIMKULU": 45, "UMZ": 45, "MOUNT AYLIFF": 45, "MOUNT FRERE": 75, "MT FRERE": 75,
    "MATATIELE": 80, "MATATIELLE": 80, "HARDING": 75, "BIZANA": 90, "TABANKULU": 105, "IZINGOLWENI": 115,
    "FLAGSTAFF": 120, "MOUNT FLETCHER": 140, "QUMBU": 145, "LUSIKISIKI": 145, "IXOPO": 120, "TSOLO": 185,
    "UMTHATHA": 185, "UMTATA": 185, "MTHATHA": 185, "PORT ST JOHNS": 200, "UGIE": 230, "IDUTYWA": 270,
    "ELLIOTDALE": 280, "DURBAN": 265, "BUTTERWORTH": 310, "KENTANI": 330, "QUEENSTOWN": 390, "EAST LONDON": 420,
}
