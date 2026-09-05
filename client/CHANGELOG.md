### 27/06/2024 (1.0.11)

-   Add webhook endpoint and auto-tunnel with hlt client (This feature is for testing purpose only).

### 27/07/2023 (1.0.10)

-   Add list profiles.

### 14/07/2023 (1.0.9)

-   Fixed the start with port unable to start.

### 11/07/2023 (1.0.8)

-   Support tunnel with host with port.

*   Prev

```
hlt start 8080 -h 192.168.1.1
```

-   New

```
hlt start 192.168.1.1:8080
```

### 11/07/2023 (1.0.7)

-   Support Client API.
-   Support Proxy (HTTP/HTTPS) and TCP.
-   Improvements and Bugs fixed.
-   Support auto proxy with hlt client.

### 30/11/2022

-   Fixed response data in axios request with accept-encoding to identity.
-   Allow to force change server url for init.

### 11/11/2022

-   Fixed axios is not a function.
-   Add generate token with data (clientId, apiKey) to server.
-   Add generate token with options (-f | --force) to regenerate and override.

### 20/10/2022

-   Upgraded packages and fixed some bugs.

### Initialized

-   HTTP tunnel between server and client via https link.
-   Custom profile (using `-p myprofile`).
-   Suffix url (using `-s`).
-   Config (get/set token,access,server,client,key configs).
