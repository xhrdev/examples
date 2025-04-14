#!/usr/bin/env python3
"""
xhr.dev proxy script for making HTTP requests through xhr.dev's proxy service.
This script demonstrates how to use xhr.dev to make requests to websites.
"""

from dotenv import load_dotenv
import os
import requests
from http.cookiejar import CookieJar
import urllib3
import sys

# Load environment variables from .env file
load_dotenv()

# Suppress only the specific InsecureRequestWarning
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Get API key from environment
xhr_api_key = os.getenv("XHR_API_KEY")
if not xhr_api_key:
  raise ValueError("Set XHR_API_KEY in .env file")

# Set up session with cookies
cookie_jar = CookieJar()
session = requests.Session()
session.cookies = cookie_jar
headers = {
  "x-xhr-api-key": xhr_api_key,
}
proxy_url = "https://magic.xhr.dev"
proxies = {
  "http": proxy_url,
  "https": proxy_url,
}


def main():
  try:
    response = session.get(
      url="https://core.cro.ie/",
      headers=headers,
      proxies=proxies,
      verify=False,
    )
    response.raise_for_status()

    if not cookie_jar:
      print("Warning: No cookies were set", file=sys.stderr)

    # Truncate long responses for readability
    response_text = response.text
    if len(response_text) > 200:
      response_text = response_text[:500] + "..."

    print("Response:", response_text)
    print("Cookies:", cookie_jar)

  except requests.exceptions.RequestException as e:
    print(f"Error making request: {e}", file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
  main()
