# Build stage
FROM mcr.microsoft.com/dotnet/sdk:8.0.404 AS build
WORKDIR /src

# Copy project files. The Tests project (referenced by the sln but only
# net10.0 + xUnit) is intentionally NOT copied here — production images
# don't need test dependencies, and the SDK 8.0 in this stage can't even
# parse net10.0. Restoring through the sln would fail with "Tests.csproj
# not found"; restoring through the API csproj directly walks ProjectReferences
# (Business + Data) and ignores the sln entirely.
COPY API/WatchTogether.API.csproj API/
COPY Business/WatchTogether.Business.csproj Business/
COPY Data/WatchTogether.Data.csproj Data/

# Restore dependencies — explicit csproj path, NOT `dotnet restore` against
# the sln (which would drag in WatchTogether.Tests and fail).
RUN dotnet restore API/WatchTogether.API.csproj

# Copy source code
COPY . .

# Build and publish
RUN dotnet publish API/WatchTogether.API.csproj -c Release -o /app/publish

# Runtime stage
FROM mcr.microsoft.com/dotnet/aspnet:8.0.11 AS runtime
WORKDIR /app

# Install curl for HEALTHCHECK. Without this, the aspnet image has no HTTP
# client binary and we'd have to fall back to a TCP-only check — which passes
# even when Kestrel is wedged but the socket is still bound. ~5MB layer cost.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/publish .

ENV ASPNETCORE_URLS=http://+:5000
ENV ASPNETCORE_ENVIRONMENT=Production

# Run as non-root (the aspnet:8.0 image creates this user with UID 1654)
USER app

EXPOSE 5000

# Real HTTP probe — hits the /api/health endpoint we map in Program.cs. If
# Kestrel deadlocks (request thread pool exhausted, GC stalls, etc.) the bound
# socket still accepts connections but this probe fails, telling Railway to
# restart the container. Tuning: interval long enough to not spam the app,
# start-period long enough that cold-start migrations don't trigger restart.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:5000/api/health || exit 1

ENTRYPOINT ["dotnet", "WatchTogether.API.dll"]
