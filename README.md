# Trace It

Trace It is a command-line tool built with Node.js that helps identify ripped anime Blu-ray episodes using trace.moe.

it helps you find the series name and episode number and renames the files accordingly.

Why you may ask?

When archiving a personal Blu-ray collection, you'll often find that existing filename databases and hashes don't match your files. Some Blu-ray releases also deliberately store episodes out of order as a copy-protection measure, making manual identification time-consuming.

Trace It automates this process by extracting frames with FFmpeg and querying trace.moe to determine the correct series and episode. Once identified, your files can be renamed consistently, making them much easier to import into media managers such as Sonarr and saving hours of manual work when organizing large Blu-ray collections.

## Features
- Identify anime episodes from locally ripped Blu-ray files.
- Works when file hashes don't match existing online databases.
- Handles releases with altered episode ordering.
- Useful for large-scale Blu-ray archive organization.
- Importing into Sonarr is much easier once episodes have been identified and renamed.

## Requirements
 - Node.js 24 LTS or newer.
 - FFmpeg installed.

## Running locally

1. `npm install`
2. `npm start -- -s ./source -o ./output`

If you wish th filter the source files by anilist id you can do the following:

- `npm start -- -s ./source -o ./output -a 9253`

### Trace.moe

Trace It uses the trace.moe for anime identification.

The application works out of the box using trace.moe's free tier, which provides enough requests to identify a number of episodes each day. If you reach the free quota, you can support the trace.moe project and use your own API key for a higher daily request limit.

For convenience, Trace It always attempts to use the free tier first. If a configured API key is available and additional requests are needed, it will automatically use the authenticated quota.

#### Adding API key

An API key for trace.moe can be set inside the `.env` and should be pasted after `TRACE_API_KEY=`.
