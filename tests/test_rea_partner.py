from rea_pipeline.rea_partner import parse_reaxml_rentals


REAXML = b"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE propertyList SYSTEM "http://reaxml.realestate.com.au/propertyList.dtd">
<propertyList date="2026-08-12-12:30:00">
  <rental modTime="2026-08-12-12:30:00" status="current">
    <agentID>ABC123</agentID>
    <uniqueID>PM-9001</uniqueID>
    <dateAvailable>2026-08-20</dateAvailable>
    <rent period="week">760</rent>
    <bond>3040</bond>
    <address display="yes">
      <subNumber>5</subNumber>
      <streetNumber>21</streetNumber>
      <street>Market Street</street>
      <suburb>Sydney</suburb>
      <state>nsw</state>
      <postcode>2000</postcode>
    </address>
    <category name="Apartment"/>
    <description>Bright city apartment.</description>
    <features>
      <bedrooms>2</bedrooms>
      <bathrooms>1</bathrooms>
      <garages>1</garages>
      <carports>1</carports>
      <study>true</study>
    </features>
    <buildingDetails><area unit="squareMeter">81</area></buildingDetails>
    <inspectionTimes><inspection>15-Aug-2026 10:00am to 10:30am</inspection></inspectionTimes>
    <externalLink href="https://www.realestate.com.au/property-apartment-nsw-sydney-9001"/>
    <images>
      <img id="a" url="https://images.example/other.jpg"/>
      <img id="m" url="https://images.example/main.jpg"/>
    </images>
  </rental>
  <rental status="leased"><agentID>ABC123</agentID><uniqueID>OLD-1</uniqueID></rental>
  <rental status="current"><agentID>ABC123</agentID></rental>
</propertyList>
"""


def test_parse_reaxml_current_rentals() -> None:
    listings, skipped = parse_reaxml_rentals(REAXML)

    assert len(listings) == 1
    assert skipped == 1
    listing = listings[0]
    assert listing.source == "rea-partner"
    assert listing.listing_id == "PM-9001"
    assert listing.full_address == "5/21 Market Street, Sydney NSW 2000"
    assert listing.state == "NSW"
    assert listing.weekly_rent == 760
    assert listing.bond_dollars == 3040
    assert listing.bedrooms == 2
    assert listing.bathrooms == 1
    assert listing.parking_spaces == 2
    assert listing.studies == 1
    assert listing.building_size == 81
    assert listing.main_image_url == "https://images.example/main.jpg"


def test_parse_reaxml_supports_studio() -> None:
    xml = """<propertyList><rental status="current"><uniqueID>S-1</uniqueID>
    <features><bedrooms>Studio</bedrooms><bathrooms>1</bathrooms></features>
    </rental></propertyList>"""

    listings, skipped = parse_reaxml_rentals(xml)

    assert skipped == 0
    assert listings[0].bedrooms == 0
