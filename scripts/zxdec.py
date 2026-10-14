# zxing-cpp decode of one image (needs: pip install zxing-cpp pillow, e.g. in a venv). Prints the text or nothing.
import sys, zxingcpp
from PIL import Image
r = zxingcpp.read_barcodes(Image.open(sys.argv[1]), formats=zxingcpp.BarcodeFormat.QRCode)
print(r[0].text if r else '')
