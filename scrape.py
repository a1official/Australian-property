import requests

payload = { 'api_key': 'b73b1a98e7197cf55daa44bfc7b81f46', 'url': 'https://realestate.com.au' }
r = requests.get('https://api.scraperapi.com/', params=payload)
print(r.text)
