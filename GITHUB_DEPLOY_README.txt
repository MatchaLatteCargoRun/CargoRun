CargoRun v3.10 — GitHub/Azure Static Web Apps deployment package

1. Create a PRIVATE GitHub repository.
2. Upload all contents of this folder, including .github.
3. In GitHub: Settings > Secrets and variables > Actions > New repository secret.
4. Name: AZURE_STATIC_WEB_APPS_API_TOKEN
5. Value: the current deployment token from Azure Static Web App > Manage deployment token.
6. Commit to the main branch.
7. GitHub Actions will deploy CargoRun automatically.

Never commit the deployment token into a file.
