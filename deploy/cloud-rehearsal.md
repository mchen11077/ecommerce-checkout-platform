# AWS and Azure rehearsal

Run the same Docker Compose stack on one temporary Ubuntu VM per provider. Use separate databases and the local rehearsal realm on each VM. Use demo identities and orders. Run the providers one at a time to keep usage low.

1. Sign in to the provider CLI and check the account plan, region and available credits. Create a dedicated AWS CloudFormation stack or Azure resource group for the rehearsal. Use an x86-64 Ubuntu VM with 4 GiB RAM and a 20 GiB disk. Restrict SSH to your current public IP. On EC2, require IMDSv2, use an encrypted volume with delete on termination, and use standard CPU credits for a burstable instance. On Azure, place the VM, disk, public IP and network resources in the same dedicated resource group. Use SSH keys.
2. Install Docker Engine and the Compose plugin. Copy the source, lockfiles and the demo deployment files to the VM. Exclude local credentials, databases, generated outputs, node_modules and .git. Keep the web and Keycloak ports bound to the VM loopback.
3. On the VM, from the repository root, run:

   ```sh
   docker compose -p ecommerce-cloud-rehearsal --project-directory . --env-file deploy/rehearsal.env -f deploy/docker-compose.release.yml -f deploy/docker-compose.rehearsal.yml up -d --build postgres keycloak migrate app web
   docker compose -p ecommerce-cloud-rehearsal --project-directory . --env-file deploy/rehearsal.env -f deploy/docker-compose.release.yml -f deploy/docker-compose.rehearsal.yml exec -T postgres psql -X -v ON_ERROR_STOP=1 -U coupon -d coupon < deploy/retail-offers.sql
   ```

4. If the workstation already runs the local rehearsal, stop that stack before forwarding the same ports. From the workstation run `ssh -N -o ExitOnForwardFailure=yes -L 5186:127.0.0.1:5186 -L 8186:127.0.0.1:8186 ubuntu@VM_IP` (use the configured Azure username when applicable). Open http://localhost:5186. Verify guest checkout and sign-in, check an in-stock count before and after checkout, simulate a refund and confirm stock returns once, then use a different paid order to simulate shipment. Verify the shipped order cannot be refunded by this demo workflow.
5. Save the pass/fail evidence without credentials. Close the tunnel. Delete the dedicated AWS stack or Azure resource group and verify the VM, disks, public IP and dedicated network resources are gone. Check the provider billing view after the usage data arrives.

References: [EC2 launch](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/LaunchingAndUsingInstances.html) and [Azure Linux VM quickstart](https://learn.microsoft.com/en-us/azure/virtual-machines/linux/quick-create-cli).
