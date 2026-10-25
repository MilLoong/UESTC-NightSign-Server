FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && useradd --uid 10001 --create-home runner
COPY login_replay ./login_replay
COPY LICENSE.upstream ./
USER 10001:10001
ENTRYPOINT ["python", "-m", "login_replay"]
CMD ["--state", "/run/secrets/login-state.json"]
