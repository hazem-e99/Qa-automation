"""Arabic-aware normalization + tokenization used for scoring (prototype of doc 14 §8 rules)."""
import re
import unicodedata

TASHKEEL = re.compile(r"[ؐ-ًؚ-ٰٟۖ-ۭـ]")  # diacritics + tatweel
ALEF = re.compile(r"[آأإٱ]")                                # آ أ إ ٱ -> ا
AR_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")
TOKEN = re.compile(r"[a-z]+|\d+|[ء-ي]+")
LAMALEF_RUN = re.compile(r"[ال]{2,}")                                 # runs of ا/ل only


def normalize(text: str) -> str:
    t = unicodedata.normalize("NFKC", text or "")      # presentation forms / ligatures -> base letters
    t = TASHKEEL.sub("", t)
    t = ALEF.sub("ا", t)
    t = t.replace("ى", "ي").replace("ة", "ه")  # ى->ي, ة->ه (matching only)
    t = t.translate(AR_DIGITS).lower()
    # PDF text layers may emit lam-alef as alef-lam: canonicalize runs of {ا,ل} by sorting them.
    t = LAMALEF_RUN.sub(lambda m: "".join(sorted(m.group(0))), t)
    return t


def tokens(text: str) -> list[str]:
    """Split at script/class boundaries so 'FR-2' and '-2FR' both give ['fr','2'] (as a bag)."""
    return TOKEN.findall(normalize(text))
